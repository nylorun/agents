package substrate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

// API is the part of Substrate's Control service the driver uses; ateapi.ControlClient has it.
type API interface {
	GetAtespace(ctx context.Context, in *ateapi.GetAtespaceRequest, opts ...grpc.CallOption) (*ateapi.Atespace, error)
	CreateActorTemplate(ctx context.Context, in *ateapi.CreateActorTemplateRequest, opts ...grpc.CallOption) (*ateapi.ActorTemplate, error)
	GetActorTemplate(ctx context.Context, in *ateapi.GetActorTemplateRequest, opts ...grpc.CallOption) (*ateapi.ActorTemplate, error)
	DeleteActorTemplate(ctx context.Context, in *ateapi.DeleteActorTemplateRequest, opts ...grpc.CallOption) (*ateapi.ActorTemplate, error)
	CreateActor(ctx context.Context, in *ateapi.CreateActorRequest, opts ...grpc.CallOption) (*ateapi.Actor, error)
	GetActor(ctx context.Context, in *ateapi.GetActorRequest, opts ...grpc.CallOption) (*ateapi.Actor, error)
	UpdateActor(ctx context.Context, in *ateapi.UpdateActorRequest, opts ...grpc.CallOption) (*ateapi.Actor, error)
	SuspendActor(ctx context.Context, in *ateapi.SuspendActorRequest, opts ...grpc.CallOption) (*ateapi.SuspendActorResponse, error)
	ResumeActor(ctx context.Context, in *ateapi.ResumeActorRequest, opts ...grpc.CallOption) (*ateapi.ResumeActorResponse, error)
	RevertActor(ctx context.Context, in *ateapi.RevertActorRequest, opts ...grpc.CallOption) (*ateapi.RevertActorResponse, error)
	DeleteActor(ctx context.Context, in *ateapi.DeleteActorRequest, opts ...grpc.CallOption) (*ateapi.Actor, error)
	CreateActorEgressPolicy(ctx context.Context, in *ateapi.CreateActorEgressPolicyRequest, opts ...grpc.CallOption) (*ateapi.EgressPolicy, error)
	UpdateActorEgressPolicy(ctx context.Context, in *ateapi.UpdateActorEgressPolicyRequest, opts ...grpc.CallOption) (*ateapi.EgressPolicy, error)
	GetActorEgressPolicy(ctx context.Context, in *ateapi.GetActorEgressPolicyRequest, opts ...grpc.CallOption) (*ateapi.EgressPolicy, error)
}

// Resolver pins an image reference to its digest (name@sha256:…).
type Resolver interface {
	Resolve(ctx context.Context, ref string) (string, error)
}

// Options configure a Driver.
type Options struct {
	Settings Settings
	// Namespace is the Tenant's namespace, where each sandbox's state ConfigMap lives.
	Namespace string
	Kube      kubernetes.Interface
	Resolver  Resolver
	Log       *slog.Logger
	// Now is the clock (tests set it).
	Now func() time.Time
	// PollInterval is how often a wait reads the actor again; default 250 ms.
	PollInterval time.Duration
	// CallTimeout bounds one Substrate call; default 2 min (a synchronous suspend writes a snapshot).
	// A resume is not bound by it: see ResumeFor.
	CallTimeout time.Duration
	// ResumeFor bounds bringing an actor to Running, all tries included; default 5 min, the
	// Runtime's own ready deadline (pods.readyDeadlineMs), past which it no longer waits. One
	// ResumeActor call may take all of it: a cold node's first resume pulls the image, and
	// cancelling the call would cancel the restore in flight.
	ResumeFor time.Duration
	// RetryWait is the first pause before trying again; it doubles up to 5 s. Default 250 ms.
	RetryWait time.Duration
}

// Driver runs sandboxes as actors. It keeps each sandbox's last request (opId, mode, template,
// image) in a ConfigMap <name>-state in the Tenant's namespace, so the service keeps no state of
// its own (Substrate's actors carry no labels or annotations to hold it).
type Driver struct {
	api    API
	o      Options
	locks  sync.Map
	synced atomic.Bool
}

// New returns a driver; Run checks Substrate answers.
func New(api API, o Options) *Driver {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.PollInterval == 0 {
		o.PollInterval = 250 * time.Millisecond
	}
	if o.CallTimeout == 0 {
		o.CallTimeout = 2 * time.Minute
	}
	if o.ResumeFor == 0 {
		o.ResumeFor = 5 * time.Minute
	}
	if o.RetryWait == 0 {
		o.RetryWait = 250 * time.Millisecond
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	return &Driver{api: api, o: o}
}

func (d *Driver) lock(name string) func() {
	value, _ := d.locks.LoadOrStore(name, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (d *Driver) ref(name string) *ateapi.ObjectRef {
	return &ateapi.ObjectRef{Atespace: d.o.Settings.Atespace, Name: name}
}

func (d *Driver) call(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d.o.CallTimeout)
}

// Synced reports whether the atespace has answered once.
func (d *Driver) Synced() bool { return d.synced.Load() }

// Ping reads the atespace: Substrate answers and lets this service in.
func (d *Driver) Ping(ctx context.Context) error {
	_, err := d.api.GetAtespace(ctx, &ateapi.GetAtespaceRequest{Atespace: &ateapi.ObjectRef{Name: d.o.Settings.Atespace}})
	if err == nil {
		d.synced.Store(true)
	}
	return err
}

// state is a sandbox's last request.
type state struct {
	OpID, Mode, Template, Image string
}

const stateSuffix = "-state"

func (d *Driver) readState(ctx context.Context, name string) (*state, error) {
	cm, err := d.o.Kube.CoreV1().ConfigMaps(d.o.Namespace).Get(ctx, name+stateSuffix, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v := cm.Data
	return &state{OpID: v["opId"], Mode: v["mode"], Template: v["template"], Image: v["image"]}, nil
}

func (d *Driver) writeState(ctx context.Context, name string, s state) error {
	data := map[string]string{"opId": s.OpID, "mode": s.Mode, "template": s.Template, "image": s.Image}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: name + stateSuffix, Namespace: d.o.Namespace, Labels: map[string]string{
			driver.ManagedLabel: driver.FieldManager, driver.SandboxLabel: name}},
		Data: data,
	}
	maps := d.o.Kube.CoreV1().ConfigMaps(d.o.Namespace)
	_, err := maps.Update(ctx, cm, metav1.UpdateOptions{})
	if apierrors.IsNotFound(err) {
		_, err = maps.Create(ctx, cm, metav1.CreateOptions{})
	}
	return err
}

func (d *Driver) deleteState(ctx context.Context, name string) error {
	err := d.o.Kube.CoreV1().ConfigMaps(d.o.Namespace).Delete(ctx, name+stateSuffix, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (d *Driver) getActor(ctx context.Context, name string) (*ateapi.Actor, error) {
	ctx, cancel := d.call(ctx)
	defer cancel()
	actor, err := d.api.GetActor(ctx, &ateapi.GetActorRequest{Actor: d.ref(name)})
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	return actor, err
}

// joinTokenOf is the join token in a template's environment.
func joinTokenOf(t *ateapi.ActorTemplate) string {
	for _, c := range t.GetContainers() {
		for _, e := range c.GetEnv() {
			if e.GetName() == "NYLORUN_JOIN_TOKEN" {
				return e.GetValue()
			}
		}
	}
	return ""
}

func networkOf(spec driver.Spec) Network {
	n := spec.Network
	if n == nil {
		return Network{}
	}
	return Network{Open: n.Preset == "open", Hosts: n.Hosts, Suffixes: n.Suffixes}
}

// Put creates or updates the sandbox `name`: its template (new when the spec changed), its
// actor, its egress policy, then resumes or suspends it. A spec whose opId the sandbox already
// records is a no-op. Resume and suspend run in the background; core waits with GET ?wait=.
func (d *Driver) Put(ctx context.Context, name string, spec driver.Spec) (driver.Status, error) {
	if err := driver.ValidateName(name); err != nil {
		return driver.Status{}, err
	}
	if err := spec.Normalize(); err != nil {
		return driver.Status{}, err
	}
	defer d.lock(name)()
	st, err := d.readState(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	actor, err := d.getActor(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	if actor != nil && actor.GetStatus().GetState() == ateapi.ActorState_ACTOR_STATE_DELETING {
		return driver.Status{}, &driver.Error{Status: http.StatusConflict, Code: "deleting", Message: "the sandbox is being deleted"}
	}
	if st != nil && actor != nil && st.OpID == spec.OpID {
		return Compute(name, actor, st), nil
	}

	images := Resolved{}
	if images.Image, err = d.o.Resolver.Resolve(ctx, spec.Image); err != nil {
		return driver.Status{}, &driver.Error{Status: http.StatusUnprocessableEntity, Code: "invalid_spec",
			Message: fmt.Sprintf("image %s: %v (Substrate runs images by digest from a registry)", spec.Image, err)}
	}
	if spec.Entrypoint == driver.EntrypointEngine && len(spec.Command) == 0 {
		if images.Harness, err = d.o.Resolver.Resolve(ctx, spec.HarnessImage); err != nil {
			return driver.Status{}, &driver.Error{Status: http.StatusUnprocessableEntity, Code: "invalid_spec",
				Message: fmt.Sprintf("harnessImage %s: %v", spec.HarnessImage, err)}
		}
	}
	token := spec.JoinToken
	if token == "" && actor != nil {
		current, err := d.getTemplate(ctx, actor.GetActorTemplate().GetName())
		if err != nil {
			return driver.Status{}, err
		}
		token = joinTokenOf(current)
	}
	if token == "" && actor == nil {
		return driver.Status{}, &driver.Error{Status: http.StatusBadRequest, Code: "invalid_request",
			Message: "joinToken is required to create a sandbox"}
	}
	rendered, err := RenderTemplate(d.o.Settings, spec, images, token)
	if err != nil {
		return driver.Status{}, err
	}
	templateName, err := TemplateName(name, rendered)
	if err != nil {
		return driver.Status{}, err
	}
	if err := d.ensureTemplate(ctx, rendered, templateName); err != nil {
		return driver.Status{}, err
	}

	switch {
	case actor == nil:
		cctx, cancel := d.call(ctx)
		actor, err = d.api.CreateActor(cctx, &ateapi.CreateActorRequest{Actor: &ateapi.Actor{
			Metadata: &ateapi.ResourceMetadata{Atespace: d.o.Settings.Atespace, Name: name}, ActorTemplate: d.ref(templateName)}})
		cancel()
		if status.Code(err) == codes.AlreadyExists {
			actor, err = d.getActor(ctx, name)
		}
		if err != nil {
			return driver.Status{}, err
		}
	case actor.GetActorTemplate().GetName() != templateName:
		// A new template takes effect at the next resume and keeps only the durable
		// directories (a template repoint): suspend first so the change applies now.
		if actor.GetStatus().GetState() == ateapi.ActorState_ACTOR_STATE_RUNNING {
			if err := d.suspend(ctx, name); err != nil {
				return driver.Status{}, err
			}
		}
		actor, err = d.getActor(ctx, name)
		if err != nil {
			return driver.Status{}, err
		}
		previous := actor.GetActorTemplate().GetName()
		actor.ActorTemplate = d.ref(templateName)
		cctx, cancel := d.call(ctx)
		actor, err = d.api.UpdateActor(cctx, &ateapi.UpdateActorRequest{Actor: actor})
		cancel()
		if err != nil {
			return driver.Status{}, err
		}
		d.deleteTemplateLater(previous) // no actor names it now, and the actor's snapshot does not need it
	}
	if err := d.ensureEgress(ctx, name, networkOf(spec)); err != nil {
		return driver.Status{}, err
	}
	next := state{OpID: spec.OpID, Mode: spec.Mode, Template: templateName, Image: images.Image}
	if err := d.writeState(ctx, name, next); err != nil {
		return driver.Status{}, err
	}
	go d.drive(name, spec.OpID, spec.Mode)
	return Compute(name, actor, &next), nil
}

// drive brings the actor to `mode` for the request opID, in the background, until a later request
// replaces it. A suspend is one call. A resume is tried again while Substrate is busy (Aborted,
// Unavailable, ResourceExhausted) or the actor is still on its way between states (a suspend still
// writing its snapshot), with a pause from RetryWait doubling to 5 s, for ResumeFor in all. A
// crashed actor, or one a failed wake left crashed, is reverted to its last snapshot once and
// resumed (Substrate refuses to resume a crashed one). The sandbox's lock is held only to read its state, never across a call: Substrate
// orders concurrent changes to one actor itself.
func (d *Driver) drive(name, opID, mode string) {
	ctx, cancel := context.WithTimeout(context.Background(), d.o.ResumeFor)
	defer cancel()
	wait, reverted := d.o.RetryWait, false
	for try := 1; ; try++ {
		again, err := d.driveOnce(ctx, name, opID, mode, &reverted)
		if !again {
			if err != nil {
				d.o.Log.Warn("substrate", "name", name, "mode", mode, "try", try, "error", err)
			}
			return
		}
		if ctx.Err() != nil {
			d.o.Log.Warn("substrate resume gave up", "name", name, "try", try, "after", d.o.ResumeFor, "error", err)
			return
		}
		if err != nil {
			d.o.Log.Info("substrate resume again", "name", name, "try", try, "error", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		wait = min(wait*2, 5*time.Second)
	}
}

// driveOnce makes one try; again says whether to try again.
func (d *Driver) driveOnce(ctx context.Context, name, opID, mode string, reverted *bool) (again bool, err error) {
	unlock := d.lock(name)
	st, err := d.readState(ctx, name)
	unlock()
	if err != nil {
		return mode == "Running", err
	}
	if st == nil || st.OpID != opID {
		return false, nil // a later request replaced this one
	}
	if mode != "Running" {
		err = d.suspend(context.Background(), name)
		if status.Code(err) == codes.FailedPrecondition {
			return false, nil // not running: nothing to suspend
		}
		return false, err
	}
	start := d.o.Now()
	res, err := d.api.ResumeActor(ctx, &ateapi.ResumeActorRequest{Actor: d.ref(name)})
	switch status.Code(err) {
	case codes.OK:
		if res.GetResumed() {
			d.o.Log.Info("substrate resumed", "name", name, "ms", d.o.Now().Sub(start).Milliseconds())
		}
		return false, nil
	case codes.Aborted, codes.Unavailable, codes.ResourceExhausted:
		return true, err
	case codes.NotFound, codes.InvalidArgument, codes.PermissionDenied, codes.Unauthenticated, codes.DeadlineExceeded,
		codes.Canceled:
		return false, err
	default:
		// The actor is in no state to resume (FailedPrecondition), or the resume failed while
		// waking it, which leaves it crashed: see which.
		actor, gerr := d.getActor(ctx, name)
		if gerr != nil || actor == nil {
			return false, err
		}
		switch actor.GetStatus().GetState() {
		case ateapi.ActorState_ACTOR_STATE_RUNNING:
			return false, nil
		case ateapi.ActorState_ACTOR_STATE_SUSPENDING, ateapi.ActorState_ACTOR_STATE_RESUMING,
			ateapi.ActorState_ACTOR_STATE_REVERTING:
			return true, err
		case ateapi.ActorState_ACTOR_STATE_CRASHED:
			if *reverted {
				return false, fmt.Errorf("crashed again after a revert: %w", err)
			}
			*reverted = true
			d.o.Log.Warn("substrate actor crashed: reverting to its last snapshot", "name", name,
				"crash", actor.GetStatus().GetCrash().GetMessage())
			cctx, cancel := d.call(ctx)
			_, rerr := d.api.RevertActor(cctx, &ateapi.RevertActorRequest{Actor: d.ref(name)})
			cancel()
			if rerr != nil {
				return false, fmt.Errorf("revert: %w", rerr)
			}
			return true, nil
		}
	}
	return false, err
}

func (d *Driver) suspend(ctx context.Context, name string) error {
	ctx, cancel := d.call(ctx)
	defer cancel()
	_, err := d.api.SuspendActor(ctx, &ateapi.SuspendActorRequest{Actor: d.ref(name),
		Options: &ateapi.SuspendOptions{Mode: ateapi.DurabilityMode_DURABILITY_MODE_SYNCHRONOUS}})
	return err
}

func (d *Driver) getTemplate(ctx context.Context, name string) (*ateapi.ActorTemplate, error) {
	ctx, cancel := d.call(ctx)
	defer cancel()
	return d.api.GetActorTemplate(ctx, &ateapi.GetActorTemplateRequest{ActorTemplate: d.ref(name)})
}

func (d *Driver) ensureTemplate(ctx context.Context, rendered map[string]any, name string) error {
	t, err := ToProto(rendered, name)
	if err != nil {
		return err
	}
	ctx, cancel := d.call(ctx)
	defer cancel()
	_, err = d.api.CreateActorTemplate(ctx, &ateapi.CreateActorTemplateRequest{ActorTemplate: t})
	if status.Code(err) == codes.AlreadyExists {
		return nil
	}
	return err
}

// deleteTemplateLater deletes, in the background, a template no actor names any more.
func (d *Driver) deleteTemplateLater(name string) {
	if name == "" {
		return
	}
	go func() {
		ctx, cancel := d.call(context.Background())
		defer cancel()
		_, err := d.api.DeleteActorTemplate(ctx, &ateapi.DeleteActorTemplateRequest{ActorTemplate: d.ref(name)})
		if err != nil && status.Code(err) != codes.NotFound {
			d.o.Log.Warn("substrate: template kept", "template", name, "error", err)
		}
	}()
}

func (d *Driver) ensureEgress(ctx context.Context, name string, network Network) error {
	policy, err := EgressPolicy(d.o.Settings, network)
	if err != nil {
		return err
	}
	policy.Metadata = &ateapi.ResourceMetadata{Atespace: d.o.Settings.Atespace, Name: "default"}
	cctx, cancel := d.call(ctx)
	defer cancel()
	_, err = d.api.CreateActorEgressPolicy(cctx, &ateapi.CreateActorEgressPolicyRequest{Actor: d.ref(name), EgressPolicy: policy})
	if status.Code(err) != codes.AlreadyExists {
		return err
	}
	current, err := d.api.GetActorEgressPolicy(cctx, &ateapi.GetActorEgressPolicyRequest{Actor: d.ref(name), Name: "default"})
	if err != nil {
		return err
	}
	policy.Metadata = current.GetMetadata()
	_, err = d.api.UpdateActorEgressPolicy(cctx, &ateapi.UpdateActorEgressPolicyRequest{Actor: d.ref(name), EgressPolicy: policy})
	return err
}

// Delete deletes the actor, its templates and its state. Deleting a sandbox that is gone succeeds.
func (d *Driver) Delete(ctx context.Context, name string) (driver.Status, error) {
	if err := driver.ValidateName(name); err != nil {
		return driver.Status{}, err
	}
	defer d.lock(name)()
	st, err := d.readState(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	actor, err := d.getActor(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	if actor != nil && actor.GetStatus().GetState() != ateapi.ActorState_ACTOR_STATE_DELETING {
		cctx, cancel := d.call(ctx)
		_, err = d.api.DeleteActor(cctx, &ateapi.DeleteActorRequest{Actor: d.ref(name)})
		cancel()
		if err != nil && status.Code(err) != codes.NotFound {
			return driver.Status{}, err
		}
	}
	templates := map[string]bool{}
	if actor != nil {
		templates[actor.GetActorTemplate().GetName()] = true
	}
	if st != nil {
		templates[st.Template] = true
	}
	go d.deleteTemplatesWhenGone(name, templates)
	if err := d.deleteState(ctx, name); err != nil {
		return driver.Status{}, err
	}
	s := driver.Status{Name: name, Volume: "missing"}
	if actor != nil {
		s.Exists, s.Deleting, s.Volume = true, true, "present"
	}
	return s, nil
}

// deleteTemplatesWhenGone deletes the templates once the actor is gone (Substrate refuses to
// delete a template an actor still names).
func (d *Driver) deleteTemplatesWhenGone(name string, templates map[string]bool) {
	ctx := context.Background()
	deadline := d.o.Now().Add(5 * time.Minute)
	for d.o.Now().Before(deadline) {
		actor, err := d.getActor(ctx, name)
		if err == nil && actor == nil {
			break
		}
		time.Sleep(time.Second)
	}
	for t := range templates {
		if t != "" {
			d.deleteTemplateLater(t)
		}
	}
}

// Status is the sandbox as Substrate reports it now.
func (d *Driver) Status(name string) (driver.Status, error) {
	if err := driver.ValidateName(name); err != nil {
		return driver.Status{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return d.status(ctx, name)
}

func (d *Driver) status(ctx context.Context, name string) (driver.Status, error) {
	actor, err := d.getActor(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	st, err := d.readState(ctx, name)
	if err != nil {
		return driver.Status{}, err
	}
	return Compute(name, actor, st), nil
}

// Compute maps an actor and the sandbox's state to the status core reads. The actor's uid
// stands for the pod's: it is stable across resumes, so the engine's join check holds.
func Compute(name string, actor *ateapi.Actor, st *state) driver.Status {
	s := driver.Status{Name: name, Volume: "missing"}
	if st != nil {
		s.OpID, s.Mode, s.ImageID = st.OpID, st.Mode, st.Image
	}
	if actor == nil {
		return s
	}
	s.Exists, s.Volume = true, "present"
	if s.Mode == "" {
		s.Mode = "Running"
	}
	switch actor.GetStatus().GetState() {
	case ateapi.ActorState_ACTOR_STATE_RUNNING:
		s.PodUID, s.PodPhase = actor.GetMetadata().GetUid(), "Running"
		s.Ready = s.Mode == "Running"
	case ateapi.ActorState_ACTOR_STATE_RESUMING, ateapi.ActorState_ACTOR_STATE_REVERTING:
		s.PodUID, s.PodPhase = actor.GetMetadata().GetUid(), "Pending"
	case ateapi.ActorState_ACTOR_STATE_SUSPENDING:
		s.PodPhase = "Terminating"
	case ateapi.ActorState_ACTOR_STATE_SUSPENDED:
		s.Suspended = s.Mode == "Suspended"
	case ateapi.ActorState_ACTOR_STATE_DELETING:
		s.Deleting = true
		s.PodPhase = "Terminating"
	case ateapi.ActorState_ACTOR_STATE_CRASHED:
		s.Reason = "Crashed"
		s.Message = strings.TrimSpace(actor.GetStatus().GetCrash().GetMessage())
	}
	return s
}

// Wait polls the actor until it reaches `want` or the timeout passes.
func (d *Driver) Wait(ctx context.Context, name, want string, timeout time.Duration) (driver.Status, bool, error) {
	if err := driver.ValidateName(name); err != nil {
		return driver.Status{}, false, err
	}
	match, ok := driver.Waits[want]
	if !ok {
		return driver.Status{}, false, &driver.Error{Status: http.StatusBadRequest, Code: "invalid_request",
			Message: "wait must be ready, suspended, expired or gone"}
	}
	deadline := time.Now().Add(timeout)
	for {
		s, err := d.status(ctx, name)
		if err != nil {
			return driver.Status{}, false, err
		}
		if match(s) {
			return s, true, nil
		}
		if !time.Now().Before(deadline) {
			return s, false, nil
		}
		select {
		case <-ctx.Done():
			return s, false, nil
		case <-time.After(d.o.PollInterval):
		}
	}
}

// Run checks every interval, until Substrate has answered once, that it answers and lets this
// service in; Synced reports it.
func (d *Driver) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if d.Synced() {
			return
		}
		if err := d.Ping(ctx); err != nil && !errors.Is(err, context.Canceled) {
			d.o.Log.Warn("substrate not ready", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
