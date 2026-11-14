package substrate

import (
	"context"
	"fmt"
	"slices"
	"sync"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// fakeAPI is Substrate's Control service in memory: templates, actors with a state machine
// (create -> SUSPENDED; resume -> RUNNING; suspend -> SUSPENDED), egress policies, atespaces
// and access policies.
type fakeAPI struct {
	mu         sync.Mutex
	templates  map[string]*ateapi.ActorTemplate
	actors     map[string]*ateapi.Actor
	policies   map[string]*ateapi.EgressPolicy
	atespaces  map[string]bool
	access     map[string]*ateapi.AccessPolicy
	uids       int
	calls      []string
	failResume error
	// failResumeTimes makes the first n ResumeActor calls fail with failResume.
	failResumeTimes int
	// crashOnResume makes the next n resumes crash the actor.
	crashOnResume int
	// refuseRepoint, when set, is UpdateActor's answer to any template change.
	refuseRepoint error
	// worker is the worker pod UID a resume places an actor on ("worker-a" when empty).
	worker string
	// failSuspendTimes makes the first n SuspendActor calls fail with Unavailable.
	failSuspendTimes int
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{templates: map[string]*ateapi.ActorTemplate{}, actors: map[string]*ateapi.Actor{},
		policies: map[string]*ateapi.EgressPolicy{}, atespaces: map[string]bool{}, access: map[string]*ateapi.AccessPolicy{}}
}

func key(r *ateapi.ObjectRef) string { return r.GetAtespace() + "/" + r.GetName() }

func (f *fakeAPI) record(call string) { f.calls = append(f.calls, call) }

func (f *fakeAPI) GetAtespace(_ context.Context, in *ateapi.GetAtespaceRequest, _ ...grpc.CallOption) (*ateapi.Atespace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.atespaces[in.GetAtespace().GetName()] {
		return nil, status.Error(codes.NotFound, "no atespace")
	}
	return &ateapi.Atespace{Metadata: &ateapi.ResourceMetadata{Name: in.GetAtespace().GetName()}}, nil
}

func (f *fakeAPI) CreateActorTemplate(_ context.Context, in *ateapi.CreateActorTemplateRequest, _ ...grpc.CallOption) (*ateapi.ActorTemplate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := in.GetActorTemplate().GetMetadata()
	k := m.GetAtespace() + "/" + m.GetName()
	if _, ok := f.templates[k]; ok {
		return nil, status.Error(codes.AlreadyExists, "exists")
	}
	f.record("CreateActorTemplate " + m.GetName())
	f.templates[k] = proto.Clone(in.GetActorTemplate()).(*ateapi.ActorTemplate)
	return f.templates[k], nil
}

func (f *fakeAPI) GetActorTemplate(_ context.Context, in *ateapi.GetActorTemplateRequest, _ ...grpc.CallOption) (*ateapi.ActorTemplate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.templates[key(in.GetActorTemplate())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no template")
	}
	return t, nil
}

func (f *fakeAPI) DeleteActorTemplate(_ context.Context, in *ateapi.DeleteActorTemplateRequest, _ ...grpc.CallOption) (*ateapi.ActorTemplate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(in.GetActorTemplate())
	for _, a := range f.actors {
		if key(a.GetActorTemplate()) == k {
			return nil, status.Error(codes.FailedPrecondition, "in use")
		}
	}
	t, ok := f.templates[k]
	if !ok {
		return nil, status.Error(codes.NotFound, "no template")
	}
	f.record("DeleteActorTemplate " + in.GetActorTemplate().GetName())
	delete(f.templates, k)
	return t, nil
}

func (f *fakeAPI) CreateActor(_ context.Context, in *ateapi.CreateActorRequest, _ ...grpc.CallOption) (*ateapi.Actor, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := in.GetActor().GetMetadata()
	k := m.GetAtespace() + "/" + m.GetName()
	if _, ok := f.actors[k]; ok {
		return nil, status.Error(codes.AlreadyExists, "exists")
	}
	if _, ok := f.templates[key(in.GetActor().GetActorTemplate())]; !ok {
		return nil, status.Error(codes.FailedPrecondition, "no template")
	}
	f.uids++
	a := proto.Clone(in.GetActor()).(*ateapi.Actor)
	a.Metadata.Uid = fmt.Sprintf("00000000-0000-4000-8000-%012d", f.uids)
	a.Metadata.Version = 1
	a.Status = &ateapi.ActorStatus{State: ateapi.ActorState_ACTOR_STATE_SUSPENDED}
	f.actors[k] = a
	f.record("CreateActor " + m.GetName())
	return proto.Clone(a).(*ateapi.Actor), nil
}

func (f *fakeAPI) GetActor(_ context.Context, in *ateapi.GetActorRequest, _ ...grpc.CallOption) (*ateapi.Actor, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actors[key(in.GetActor())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	return proto.Clone(a).(*ateapi.Actor), nil
}

func (f *fakeAPI) UpdateActor(_ context.Context, in *ateapi.UpdateActorRequest, _ ...grpc.CallOption) (*ateapi.Actor, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(&ateapi.ObjectRef{Atespace: in.GetActor().GetMetadata().GetAtespace(), Name: in.GetActor().GetMetadata().GetName()})
	a, ok := f.actors[k]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	if in.GetActor().GetMetadata().GetVersion() != a.GetMetadata().GetVersion() {
		return nil, status.Error(codes.Aborted, "version")
	}
	if !proto.Equal(a.GetActorTemplate(), in.GetActor().GetActorTemplate()) {
		if err := f.repointError(a, in.GetActor().GetActorTemplate()); err != nil {
			f.record("UpdateActor refused " + a.GetMetadata().GetName())
			return nil, err
		}
	}
	a.ActorTemplate = in.GetActor().GetActorTemplate()
	a.Metadata.Version++
	f.record("UpdateActor " + a.GetMetadata().GetName() + " " + a.GetActorTemplate().GetName())
	return proto.Clone(a).(*ateapi.Actor), nil
}

func (f *fakeAPI) SuspendActor(_ context.Context, in *ateapi.SuspendActorRequest, _ ...grpc.CallOption) (*ateapi.SuspendActorResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actors[key(in.GetActor())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	if f.failSuspendTimes > 0 {
		f.failSuspendTimes--
		f.record("SuspendActor failed")
		return nil, status.Error(codes.Unavailable, "atelet busy")
	}
	f.record("SuspendActor " + a.GetMetadata().GetName())
	a.Status.State = ateapi.ActorState_ACTOR_STATE_SUSPENDED
	a.Status.WorkerAssignment = nil
	return &ateapi.SuspendActorResponse{Actor: proto.Clone(a).(*ateapi.Actor)}, nil
}

func (f *fakeAPI) ResumeActor(_ context.Context, in *ateapi.ResumeActorRequest, _ ...grpc.CallOption) (*ateapi.ResumeActorResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failResume != nil && f.failResumeTimes != 0 {
		if f.failResumeTimes > 0 {
			f.failResumeTimes--
		}
		f.record("ResumeActor failed")
		return nil, f.failResume
	}
	a, ok := f.actors[key(in.GetActor())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	switch a.Status.State {
	case ateapi.ActorState_ACTOR_STATE_RUNNING:
		return &ateapi.ResumeActorResponse{Actor: proto.Clone(a).(*ateapi.Actor)}, nil
	case ateapi.ActorState_ACTOR_STATE_SUSPENDED:
	default:
		f.record("ResumeActor refused " + a.Status.State.String())
		return nil, status.Error(codes.FailedPrecondition, "not suspended")
	}
	f.record("ResumeActor " + a.GetMetadata().GetName())
	a.Status.State = ateapi.ActorState_ACTOR_STATE_RUNNING
	worker := f.worker
	if worker == "" {
		worker = "worker-a"
	}
	a.Status.WorkerAssignment = &ateapi.WorkerAssignment{WorkerPodUid: worker}
	if f.crashOnResume > 0 {
		f.crashOnResume--
		a.Status.State = ateapi.ActorState_ACTOR_STATE_CRASHED
		return nil, status.Error(codes.Internal, "the sandbox died while waking")
	}
	return &ateapi.ResumeActorResponse{Actor: proto.Clone(a).(*ateapi.Actor), Resumed: true}, nil
}

func (f *fakeAPI) RevertActor(_ context.Context, in *ateapi.RevertActorRequest, _ ...grpc.CallOption) (*ateapi.RevertActorResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actors[key(in.GetActor())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	if a.Status.State != ateapi.ActorState_ACTOR_STATE_CRASHED {
		return nil, status.Error(codes.FailedPrecondition, "not crashed")
	}
	f.record("RevertActor " + a.GetMetadata().GetName())
	a.Status.State = ateapi.ActorState_ACTOR_STATE_SUSPENDED
	return &ateapi.RevertActorResponse{Actor: proto.Clone(a).(*ateapi.Actor)}, nil
}

// repointError is Substrate v1.0.0's answer to repointing actor a to template `to`
// (controlapi.validatedActorMutation): only a suspended actor, only to a template that exists,
// and only one with the same volumes and, for each container in both, the same volume mounts
// (validateTemplateVolumesUnchanged). With its current template gone there is nothing to compare.
func (f *fakeAPI) repointError(a *ateapi.Actor, to *ateapi.ObjectRef) error {
	if state := a.GetStatus().GetState(); state != ateapi.ActorState_ACTOR_STATE_SUSPENDED {
		return status.Errorf(codes.FailedPrecondition, "actor must be %s to change its actor template (got: %s)",
			ateapi.ActorState_ACTOR_STATE_SUSPENDED, state)
	}
	next, ok := f.templates[key(to)]
	if !ok {
		return status.Error(codes.FailedPrecondition, "actor template not found")
	}
	if f.refuseRepoint != nil {
		return f.refuseRepoint
	}
	old, ok := f.templates[key(a.GetActorTemplate())]
	if !ok {
		return nil
	}
	if !slices.EqualFunc(old.GetVolumes(), next.GetVolumes(), func(x, y *ateapi.Volume) bool { return proto.Equal(x, y) }) {
		return status.Error(codes.FailedPrecondition,
			"volumes differ between the current and the new actor template; volumes must be identical to repoint an actor")
	}
	containers := map[string]*ateapi.Container{}
	for _, c := range next.GetContainers() {
		containers[c.GetName()] = c
	}
	for _, c := range old.GetContainers() {
		n, ok := containers[c.GetName()]
		if ok && !slices.EqualFunc(c.GetVolumeMounts(), n.GetVolumeMounts(), func(x, y *ateapi.VolumeMount) bool { return proto.Equal(x, y) }) {
			return status.Errorf(codes.FailedPrecondition,
				"volume mounts of container %q differ between the current and the new actor template; volume mounts must be identical to repoint an actor", c.GetName())
		}
	}
	return nil
}

// setState puts an actor in a state, as Substrate would on its own.
func (f *fakeAPI) setState(name string, state ateapi.ActorState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actors[space+"/"+name].Status.State = state
}

func (f *fakeAPI) count(call string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (f *fakeAPI) DeleteActor(_ context.Context, in *ateapi.DeleteActorRequest, _ ...grpc.CallOption) (*ateapi.Actor, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(in.GetActor())
	a, ok := f.actors[k]
	if !ok {
		return nil, status.Error(codes.NotFound, "no actor")
	}
	f.record("DeleteActor " + a.GetMetadata().GetName())
	delete(f.actors, k)
	delete(f.policies, k)
	return a, nil
}

func (f *fakeAPI) CreateActorEgressPolicy(_ context.Context, in *ateapi.CreateActorEgressPolicyRequest, _ ...grpc.CallOption) (*ateapi.EgressPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(in.GetActor())
	if _, ok := f.policies[k]; ok {
		return nil, status.Error(codes.AlreadyExists, "exists")
	}
	p := proto.Clone(in.GetEgressPolicy()).(*ateapi.EgressPolicy)
	p.Metadata.Version = 1
	f.policies[k] = p
	return p, nil
}

func (f *fakeAPI) UpdateActorEgressPolicy(_ context.Context, in *ateapi.UpdateActorEgressPolicyRequest, _ ...grpc.CallOption) (*ateapi.EgressPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key(in.GetActor())
	current, ok := f.policies[k]
	if !ok {
		return nil, status.Error(codes.NotFound, "no policy")
	}
	if in.GetEgressPolicy().GetMetadata().GetVersion() != current.GetMetadata().GetVersion() {
		return nil, status.Error(codes.Aborted, "version")
	}
	p := proto.Clone(in.GetEgressPolicy()).(*ateapi.EgressPolicy)
	p.Metadata.Version++
	f.policies[k] = p
	return p, nil
}

func (f *fakeAPI) GetActorEgressPolicy(_ context.Context, in *ateapi.GetActorEgressPolicyRequest, _ ...grpc.CallOption) (*ateapi.EgressPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if in.GetName() == "" { // as Substrate v1.0.0
		return nil, status.Error(codes.InvalidArgument, "name: Required value")
	}
	p, ok := f.policies[key(in.GetActor())]
	if !ok {
		return nil, status.Error(codes.NotFound, "no policy")
	}
	return p, nil
}

func (f *fakeAPI) CreateAtespace(_ context.Context, in *ateapi.CreateAtespaceRequest, _ ...grpc.CallOption) (*ateapi.Atespace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	name := in.GetAtespace().GetMetadata().GetName()
	if f.atespaces[name] {
		return nil, status.Error(codes.AlreadyExists, "exists")
	}
	f.atespaces[name] = true
	return in.GetAtespace(), nil
}

func (f *fakeAPI) GetAtespaceAccessPolicy(_ context.Context, in *ateapi.GetAtespaceAccessPolicyRequest, _ ...grpc.CallOption) (*ateapi.AccessPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.access[in.GetAtespace().GetName()]
	if !ok {
		return nil, status.Error(codes.NotFound, "no policy")
	}
	return proto.Clone(p).(*ateapi.AccessPolicy), nil
}

func (f *fakeAPI) CreateAtespaceAccessPolicy(_ context.Context, in *ateapi.CreateAtespaceAccessPolicyRequest, _ ...grpc.CallOption) (*ateapi.AccessPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if in.GetAccessPolicy().GetMetadata().GetAtespace() != "" { // as Substrate v1.0.0: an atespace's policy is global-scoped
		return nil, status.Error(codes.InvalidArgument, "access_policy.metadata.atespace: Forbidden: must not be set")
	}
	name := in.GetAtespace().GetName()
	if _, ok := f.access[name]; ok {
		return nil, status.Error(codes.AlreadyExists, "exists")
	}
	f.access[name] = proto.Clone(in.GetAccessPolicy()).(*ateapi.AccessPolicy)
	return f.access[name], nil
}

func (f *fakeAPI) UpdateAtespaceAccessPolicy(_ context.Context, in *ateapi.UpdateAtespaceAccessPolicyRequest, _ ...grpc.CallOption) (*ateapi.AccessPolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if in.GetAccessPolicy().GetMetadata().GetAtespace() != "" { // as Substrate v1.0.0: an atespace's policy is global-scoped
		return nil, status.Error(codes.InvalidArgument, "access_policy.metadata.atespace: Forbidden: must not be set")
	}
	f.access[in.GetAtespace().GetName()] = proto.Clone(in.GetAccessPolicy()).(*ateapi.AccessPolicy)
	return f.access[in.GetAtespace().GetName()], nil
}

// fakeResolver pins every tag to a fixed digest and counts lookups.
type fakeResolver struct {
	mu   sync.Mutex
	refs []string
	fail error
}

func (r *fakeResolver) Resolve(_ context.Context, ref string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		return "", r.fail
	}
	r.refs = append(r.refs, ref)
	return ref + "@sha256:" + fmt.Sprintf("%064d", len(ref)), nil
}
