package substrate

import (
	"context"
	"strings"
	"testing"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func stoppingWorker(uid string, at time.Time) *corev1.Pod {
	deleted := metav1.NewTime(at)
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "gvisor-" + uid, Namespace: "nylorun-workers", UID: types.UID(uid),
		Labels: map[string]string{WorkerPoolLabel: "gvisor"}, DeletionTimestamp: &deleted}}
}

func (r *rig) count(call string) int {
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	n := 0
	for _, c := range r.api.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (r *rig) state(t *testing.T) *state {
	t.Helper()
	st, err := r.d.readState(context.Background(), sbx)
	if err != nil || st == nil {
		t.Fatalf("state: %v %v", st, err)
	}
	return st
}

func TestADrainedSandboxIsSuspendedThenResumedElsewhere(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.api.worker = "worker-b" // the next placement: another worker
	r.d.DrainWorker(context.Background(), stoppingWorker("worker-a", r.now))
	if r.count("SuspendActor "+sbx) != 1 {
		t.Fatalf("calls: %v", r.api.calls)
	}
	st := r.state(t)
	if st.DrainedAt == "" || st.OpID != "op-1" || st.Mode != "Running" {
		t.Fatalf("state after the drain: %+v", st)
	}
	s := r.wait(t, "ready")
	if s.DrainedAt != st.DrainedAt || s.Reason != "" {
		t.Fatalf("status after the move: %+v", s)
	}
	a, _ := r.d.getActor(context.Background(), sbx)
	if a.GetStatus().GetWorkerAssignment().GetWorkerPodUid() != "worker-b" {
		t.Fatalf("resumed on %q", a.GetStatus().GetWorkerAssignment().GetWorkerPodUid())
	}
	// A later request keeps the drain's time: the Runtime records each drain once.
	next := spec("op-2", "Running")
	next.JoinToken = ""
	if _, err := r.d.Put(context.Background(), sbx, next); err != nil {
		t.Fatal(err)
	}
	if r.state(t).DrainedAt != st.DrainedAt {
		t.Fatal("a new request dropped the drain's time")
	}
}

func TestADrainedSandboxReportsMovingUntilItRuns(t *testing.T) {
	st := &state{OpID: "op-1", Mode: "Running", DrainedAt: "2026-11-14T10:00:00Z"}
	actor := &ateapi.Actor{Metadata: &ateapi.ResourceMetadata{Uid: "u"}, Status: &ateapi.ActorStatus{State: ateapi.ActorState_ACTOR_STATE_SUSPENDED}}
	if s := Compute(sbx, actor, st); s.Reason != Moving || s.Ready || s.DrainedAt != st.DrainedAt {
		t.Fatalf("suspended by a drain: %+v", s)
	}
	actor.Status.State = ateapi.ActorState_ACTOR_STATE_RUNNING
	if s := Compute(sbx, actor, st); s.Reason != "" || !s.Ready {
		t.Fatalf("running again: %+v", s)
	}
	actor.Status.State = ateapi.ActorState_ACTOR_STATE_CRASHED
	if s := Compute(sbx, actor, st); s.Reason != "Crashed" {
		t.Fatalf("a crash is still a crash: %+v", s)
	}
}

func TestADrainLeavesOtherWorkersAndSuspendedRequestsAlone(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.d.DrainWorker(context.Background(), stoppingWorker("worker-z", r.now))
	if r.count("SuspendActor "+sbx) != 0 {
		t.Fatalf("drained an actor on another worker: %v", r.api.calls)
	}
	// Asked to suspend while its worker stops: suspended, and not resumed.
	pause := spec("op-2", "Suspended")
	pause.JoinToken = ""
	r.api.mu.Lock()
	r.api.actors[space+"/"+sbx].Status.State = ateapi.ActorState_ACTOR_STATE_RUNNING
	r.api.mu.Unlock()
	if err := r.d.writeState(context.Background(), sbx, state{OpID: "op-2", Mode: "Suspended", Template: r.state(t).Template}); err != nil {
		t.Fatal(err)
	}
	r.d.DrainWorker(context.Background(), stoppingWorker("worker-a", r.now))
	time.Sleep(50 * time.Millisecond)
	if r.count("SuspendActor "+sbx) != 1 || r.count("ResumeActor "+sbx) != 1 {
		t.Fatalf("calls: %v", r.api.calls)
	}
}

func TestADrainTriesTheSuspendAgainAndOnlyOncePerPod(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.api.failSuspendTimes = 2
	pod := stoppingWorker("worker-a", r.now)
	r.d.DrainWorker(context.Background(), pod)
	r.d.DrainWorker(context.Background(), pod) // the informer's next update: already drained
	calls := strings.Join(r.api.calls, "\n")
	if strings.Count(calls, "SuspendActor failed") != 2 || r.count("SuspendActor "+sbx) != 1 {
		t.Fatalf("calls: %v", r.api.calls)
	}
	if r.state(t).DrainedAt == "" {
		t.Fatal("no drain recorded")
	}
}
