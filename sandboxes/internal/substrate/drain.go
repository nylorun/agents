package substrate

import (
	"context"
	"sync"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/tools/cache"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

// Suspend before drain follows Agent Substrate's eviction contract (its API guide, "Eviction"):
// a worker pod that stops sends each of its actors SIGTERM, then gives them 30 minutes, counted
// from the pod's SIGTERM, to be suspended. Substrate doesn't suspend them: whatever drives the
// actor has to, synchronously. Our engine stays up on that SIGTERM (NYLORUN_SANDBOX_SUBSTRATE),
// and this watcher, seeing a worker pod turn Terminating, suspends each of the Tenant's actors
// on it, records the drain, and resumes the ones whose request is Running. Substrate places a
// resume only on an ACTIVE worker, so they land on another one.

// WorkerPoolLabel names the WorkerPool on each of its worker pods (Substrate's atecontroller).
const WorkerPoolLabel = "ate.dev/worker-pool"

// DrainWindow is how long after a worker pod's deletion this service keeps trying to suspend its
// actors: ateworker kills what is left at 30 minutes.
const DrainWindow = 29 * time.Minute

// drainParallel is how many of one worker's actors are suspended at once.
const drainParallel = 8

// drains tracks the worker pods being drained, by UID.
type drains struct{ active sync.Map }

// WatchWorkers watches every worker pod (label ate.dev/worker-pool) and drains each one that
// turns Terminating. A pod already Terminating when the service starts is drained on the first
// list. It returns when ctx ends.
func (d *Driver) WatchWorkers(ctx context.Context) {
	factory := informers.NewSharedInformerFactoryWithOptions(d.o.Kube, 10*time.Minute,
		informers.WithTweakListOptions(func(o *metav1.ListOptions) { o.LabelSelector = WorkerPoolLabel }))
	pods := factory.Core().V1().Pods().Informer()
	seen := func(obj any) {
		if pod, ok := obj.(*corev1.Pod); ok && pod.DeletionTimestamp != nil {
			go d.DrainWorker(ctx, pod)
		}
	}
	_, _ = pods.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    seen,
		UpdateFunc: func(_, obj any) { seen(obj) },
		DeleteFunc: func(obj any) {
			if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
				obj = tomb.Obj
			}
			if pod, ok := obj.(*corev1.Pod); ok {
				d.drains.active.Delete(string(pod.UID))
			}
		},
	})
	factory.Start(ctx.Done())
	<-ctx.Done()
	factory.Shutdown()
}

// DrainWorker suspends the Tenant's actors on a stopping worker pod, once per pod: each
// synchronously, up to drainParallel at a time, trying again until DrainWindow after the pod's
// deletion. Each one suspended records its drain time, and is resumed when its request is Running.
func (d *Driver) DrainWorker(ctx context.Context, pod *corev1.Pod) {
	uid := string(pod.UID)
	if _, busy := d.drains.active.LoadOrStore(uid, true); busy {
		return
	}
	deleted := d.o.Now()
	if pod.DeletionTimestamp != nil {
		deleted = pod.DeletionTimestamp.Time
	}
	ctx, cancel := context.WithTimeout(ctx, deleted.Add(DrainWindow).Sub(d.o.Now()))
	defer cancel()
	names, err := d.actorsOn(ctx, uid)
	if err != nil {
		d.o.Log.Warn("substrate drain: listing the sandboxes failed", "worker", pod.Namespace+"/"+pod.Name, "error", err)
		d.drains.active.Delete(uid) // the next update of the pod tries again
		return
	}
	if len(names) == 0 {
		return
	}
	d.o.Log.Info("substrate drain: worker stopping", "worker", pod.Namespace+"/"+pod.Name, "sandboxes", len(names))
	slots := make(chan struct{}, drainParallel)
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			d.drainOne(ctx, name, uid)
		}()
	}
	wg.Wait()
}

// actorsOn names the Tenant's sandboxes whose actor runs on the worker pod with this UID.
func (d *Driver) actorsOn(ctx context.Context, podUID string) ([]string, error) {
	maps, err := d.o.Kube.CoreV1().ConfigMaps(d.o.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: driver.ManagedLabel + "=" + driver.FieldManager + "," + driver.SandboxLabel})
	if err != nil {
		return nil, err
	}
	var names []string
	for _, cm := range maps.Items {
		name := cm.Labels[driver.SandboxLabel]
		if name == "" || cm.Name != name+stateSuffix {
			continue
		}
		actor, err := d.getActor(ctx, name)
		if err != nil || actor == nil {
			continue
		}
		if onWorker(actor, podUID) {
			names = append(names, name)
		}
	}
	return names, nil
}

func onWorker(actor *ateapi.Actor, podUID string) bool {
	switch actor.GetStatus().GetState() {
	case ateapi.ActorState_ACTOR_STATE_RUNNING, ateapi.ActorState_ACTOR_STATE_RESUMING,
		ateapi.ActorState_ACTOR_STATE_SUSPENDING:
		return actor.GetStatus().GetWorkerAssignment().GetWorkerPodUid() == podUID
	}
	return false
}

// drainOne suspends one sandbox, trying again while time is left, then records the drain and
// resumes it elsewhere when its request is Running.
func (d *Driver) drainOne(ctx context.Context, name, podUID string) {
	start := d.o.Now()
	wait := d.o.RetryWait
	for try := 1; ; try++ {
		err := d.suspend(ctx, name)
		actor, gerr := d.getActor(ctx, name)
		if gerr == nil && actor != nil && actor.GetStatus().GetState() == ateapi.ActorState_ACTOR_STATE_SUSPENDED {
			break
		}
		if gerr == nil && (actor == nil || !onWorker(actor, podUID)) {
			return // deleted, crashed or moved by something else meanwhile
		}
		if status.Code(err) == codes.NotFound {
			return
		}
		if ctx.Err() != nil {
			d.o.Log.Warn("substrate drain: gave up before the worker's deadline", "name", name, "try", try, "error", err)
			return
		}
		d.o.Log.Info("substrate drain: suspend again", "name", name, "try", try, "error", err)
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		wait = min(wait*2, 5*time.Second)
	}
	unlock := d.lock(name)
	st, err := d.readState(ctx, name)
	if err == nil && st != nil {
		st.DrainedAt = d.o.Now().UTC().Format(time.RFC3339Nano)
		err = d.writeState(ctx, name, *st)
	}
	unlock()
	if err != nil {
		d.o.Log.Warn("substrate drain: recording the drain failed", "name", name, "error", err)
	}
	d.o.Log.Info("substrate drained", "name", name, "ms", d.o.Now().Sub(start).Milliseconds())
	if st != nil && st.Mode == "Running" && st.Refused == "" {
		go d.drive(name, st.OpID, "Running")
	}
}
