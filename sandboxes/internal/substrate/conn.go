package substrate

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
)

// What Substrate's install names, as `kubectl ate` reads them (Substrate v1.0.0,
// internal/ateclient): ate-api-server's certificate is signed by the service-DNS signer, whose
// live bundle is a ClusterTrustBundle; it serves on its Service's port 443 under the name
// <service>.<namespace>.svc, which is also the audience of the tokens it accepts.
const (
	serviceDNSSigner   = "servicedns.podcert.ate.dev/identity"
	liveBundleSelector = "podcert.ate.dev/canarying=live"
	apiPort            = 443
	tokenSeconds       = int64(3600)
)

// ConnOptions say where Substrate's API is and who this service is to it.
type ConnOptions struct {
	Rest *rest.Config
	Kube kubernetes.Interface
	// SystemNamespace and APIService locate ate-api-server (ate-system, api).
	SystemNamespace, APIService string
	// Endpoint, when set, is dialed instead of a port-forward.
	Endpoint string
	// Namespace and ServiceAccount are this service's identity: it mints its own token.
	Namespace, ServiceAccount string
	// StaticToken, when set, is sent instead (substrate-setup, as one of Substrate's owners).
	StaticToken string
}

func (o ConnOptions) serverName() string { return o.APIService + "." + o.SystemNamespace + ".svc" }

// Dial connects to ate-api-server. The connection re-establishes its port-forward when it drops.
func Dial(ctx context.Context, o ConnOptions) (ateapi.ControlClient, func(), error) {
	roots, err := ServerTrust(ctx, o.Kube)
	if err != nil {
		return nil, nil, err
	}
	var tokens credentials.PerRPCCredentials = &tokenSource{kube: o.Kube, namespace: o.Namespace, account: o.ServiceAccount, audience: o.serverName()}
	if o.StaticToken != "" {
		tokens = staticToken(o.StaticToken)
	}
	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: o.serverName()})),
		grpc.WithPerRPCCredentials(tokens),
	}
	target := o.Endpoint
	closeFn := func() {}
	if target == "" {
		fw := &forwarder{o: o}
		opts = append(opts, grpc.WithContextDialer(fw.dial))
		target = "passthrough:///" + o.serverName()
		closeFn = fw.close
	}
	conn, err := grpc.NewClient(target, opts...)
	if err != nil {
		closeFn()
		return nil, nil, err
	}
	return ateapi.NewControlClient(conn), func() { _ = conn.Close(); closeFn() }, nil
}

// ServerTrust is the live service-DNS bundle: the roots ate-api-server's certificate chains to.
// It reads ClusterTrustBundles at certificates.k8s.io/v1 (Kubernetes 1.37) or v1beta1.
func ServerTrust(ctx context.Context, kube kubernetes.Interface) (*x509.CertPool, error) {
	type bundle struct{ signer, pem string }
	var bundles []bundle
	list, err := kube.CertificatesV1().ClusterTrustBundles().List(ctx, metav1.ListOptions{LabelSelector: liveBundleSelector})
	if err == nil {
		for _, b := range list.Items {
			bundles = append(bundles, bundle{b.Spec.SignerName, b.Spec.TrustBundle})
		}
	} else {
		beta, berr := kube.CertificatesV1beta1().ClusterTrustBundles().List(ctx, metav1.ListOptions{LabelSelector: liveBundleSelector})
		if berr != nil {
			return nil, fmt.Errorf("read Substrate's ClusterTrustBundles: %w", err)
		}
		for _, b := range beta.Items {
			bundles = append(bundles, bundle{b.Spec.SignerName, b.Spec.TrustBundle})
		}
	}
	pool := x509.NewCertPool()
	found := false
	for _, b := range bundles {
		if b.signer == serviceDNSSigner && pool.AppendCertsFromPEM([]byte(b.pem)) {
			found = true
		}
	}
	if !found {
		return nil, fmt.Errorf("no live ClusterTrustBundle for %s: is Substrate installed?", serviceDNSSigner)
	}
	return pool, nil
}

// tokenSource mints this service's Substrate token (TokenRequest on its own ServiceAccount)
// and renews it 10 minutes before it expires.
type tokenSource struct {
	kube                         kubernetes.Interface
	namespace, account, audience string
	mu                           sync.Mutex
	token                        string
	expires                      time.Time
}

func (t *tokenSource) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token == "" || time.Until(t.expires) < 10*time.Minute {
		seconds := tokenSeconds
		res, err := t.kube.CoreV1().ServiceAccounts(t.namespace).CreateToken(ctx, t.account, &authv1.TokenRequest{
			Spec: authv1.TokenRequestSpec{Audiences: []string{t.audience}, ExpirationSeconds: &seconds}}, metav1.CreateOptions{})
		if err != nil {
			return nil, fmt.Errorf("mint the Substrate token for %s/%s: %w", t.namespace, t.account, err)
		}
		t.token, t.expires = res.Status.Token, res.Status.ExpirationTimestamp.Time
	}
	return map[string]string{"authorization": "Bearer " + t.token}, nil
}

func (t *tokenSource) RequireTransportSecurity() bool { return true }

type staticToken string

func (t staticToken) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + string(t)}, nil
}

func (t staticToken) RequireTransportSecurity() bool { return true }

// forwarder keeps a port-forward to a ready ate-api-server pod and dials through it; a dial
// after the forward failed opens a new one.
type forwarder struct {
	o    ConnOptions
	mu   sync.Mutex
	port int
	stop chan struct{}
	dead chan struct{}
}

func (f *forwarder) dial(ctx context.Context, _ string) (net.Conn, error) {
	port, err := f.ensure(ctx)
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

func (f *forwarder) ensure(ctx context.Context) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dead != nil {
		select {
		case <-f.dead:
			f.port = 0
		default:
			return f.port, nil
		}
	}
	pod, port, err := apiPod(ctx, f.o.Kube, f.o.SystemNamespace, f.o.APIService)
	if err != nil {
		return 0, err
	}
	req := f.o.Kube.CoreV1().RESTClient().Post().Resource("pods").Namespace(f.o.SystemNamespace).Name(pod).SubResource("portforward")
	dialer, err := portforward.NewSPDYOverWebsocketDialer(req.URL(), f.o.Rest)
	if err != nil {
		return 0, err
	}
	stop, ready, dead := make(chan struct{}), make(chan struct{}), make(chan struct{})
	pf, err := portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, []string{"0:" + strconv.Itoa(int(port))}, stop, ready, io.Discard, io.Discard)
	if err != nil {
		return 0, err
	}
	failed := make(chan error, 1)
	go func() {
		failed <- pf.ForwardPorts()
		close(dead)
	}()
	select {
	case <-ready:
	case err := <-failed:
		return 0, fmt.Errorf("port-forward to %s/%s: %w", f.o.SystemNamespace, pod, err)
	case <-ctx.Done():
		close(stop)
		return 0, ctx.Err()
	}
	ports, err := pf.GetPorts()
	if err != nil || len(ports) == 0 {
		close(stop)
		return 0, errors.New("port-forward opened no port")
	}
	f.port, f.stop, f.dead = int(ports[0].Local), stop, dead
	return f.port, nil
}

func (f *forwarder) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stop != nil {
		select {
		case <-f.stop:
		default:
			close(f.stop)
		}
	}
}

// apiPod is a ready pod behind the API Service and the container port its port 443 targets.
func apiPod(ctx context.Context, kube kubernetes.Interface, namespace, service string) (string, int32, error) {
	svc, err := kube.CoreV1().Services(namespace).Get(ctx, service, metav1.GetOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("Substrate's %s/%s Service: %w", namespace, service, err)
	}
	pods, err := kube.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: labels.SelectorFromSet(svc.Spec.Selector).String()})
	if err != nil {
		return "", 0, err
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if !ready(pod) {
			continue
		}
		for _, sp := range svc.Spec.Ports {
			if sp.Port != apiPort {
				continue
			}
			switch sp.TargetPort.Type {
			case intstr.Int:
				if sp.TargetPort.IntVal == 0 {
					return pod.Name, sp.Port, nil
				}
				return pod.Name, sp.TargetPort.IntVal, nil
			case intstr.String:
				for _, c := range pod.Spec.Containers {
					for _, cp := range c.Ports {
						if cp.Name == sp.TargetPort.StrVal {
							return pod.Name, cp.ContainerPort, nil
						}
					}
				}
			}
		}
		return "", 0, fmt.Errorf("Substrate's %s Service has no port %d", service, apiPort)
	}
	return "", 0, fmt.Errorf("no ready %s pod in %s", service, namespace)
}

func ready(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning || pod.DeletionTimestamp != nil {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}
