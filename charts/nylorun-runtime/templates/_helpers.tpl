{{- define "nylorun.name" -}}{{ .Release.Name | trunc 40 | trimSuffix "-" }}{{- end -}}

{{- define "nylorun.labels" -}}
app.kubernetes.io/part-of: nylorun-runtime
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nylorun.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "nylorun.image.runtime" -}}{{ .Values.images.runtime | default (printf "ghcr.io/nylorun/runtime:%s" .Chart.AppVersion) }}{{- end -}}
{{- define "nylorun.image.studio" -}}{{ .Values.images.studio | default (printf "ghcr.io/nylorun/studio:%s" (index .Chart.Annotations "nylorun.com/studio-version")) }}{{- end -}}
{{- define "nylorun.image.sandboxes" -}}{{ .Values.images.sandboxes | default (printf "ghcr.io/nylorun/sandboxes:%s" .Chart.AppVersion) }}{{- end -}}

{{- define "nylorun.image.computer" -}}{{ .Values.computer.image | default (printf "ghcr.io/nylorun/computer:%s" (index .Chart.Annotations "nylorun.com/computer-version")) }}{{- end -}}

{{/* What serves a computer: go (the computer agent) or engine (the Runtime's). */}}
{{- define "nylorun.computer.agent" -}}
{{- if not (has .Values.computer.agent (list "go" "engine")) -}}
{{- fail (printf "computer.agent must be go or engine, not %v" .Values.computer.agent) -}}
{{- end -}}
{{ .Values.computer.agent }}
{{- end -}}

{{/* The image computers mount at /nylo, for the pre-pull. */}}
{{- define "nylorun.image.nylo" -}}
{{- if eq (include "nylorun.computer.agent" .) "go" -}}{{ include "nylorun.image.computer" . }}{{- else -}}{{ include "nylorun.image.runtime" . }}{{- end -}}
{{- end -}}

{{- define "nylorun.atespace" -}}{{ .Values.substrate.atespace | default (printf "nylorun-%s" .Release.Namespace) }}{{- end -}}

{{/* Service names */}}
{{- define "nylorun.svc" -}}{{ include "nylorun.name" .root }}-{{ .name }}{{- end -}}

{{- define "nylorun.secret" -}}{{ include "nylorun.name" . }}-secrets{{- end -}}

{{- define "nylorun.publicUrl" -}}
{{- if .Values.publicUrl -}}{{ .Values.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}https://{{ .Values.ingress.host }}
{{- else -}}http://{{ include "nylorun.name" . }}-runtime:4000{{- end -}}
{{- end -}}

{{/* The Postgres URL: from a Secret (external or generated). */}}
{{- define "nylorun.postgres.secret" -}}
{{- if .Values.postgres.existingSecret -}}{{ .Values.postgres.existingSecret }}{{- else -}}{{ include "nylorun.secret" . }}{{- end -}}
{{- end -}}

{{- define "nylorun.objectStore.secret" -}}
{{- if .Values.objectStore.existingSecret -}}{{ .Values.objectStore.existingSecret }}{{- else -}}{{ include "nylorun.secret" . }}{{- end -}}
{{- end -}}

{{- define "nylorun.objectStore.endpoint" -}}
{{- if .Values.objectStore.endpoint -}}{{ .Values.objectStore.endpoint }}{{- else -}}http://{{ include "nylorun.name" . }}-rustfs:9000{{- end -}}
{{- end -}}

{{/* The object store's variables for the runtime and the gateway. */}}
{{- define "nylorun.objectStore.env" -}}
- name: NYLORUN_OBJECT_STORE_ENDPOINT
  value: {{ include "nylorun.objectStore.endpoint" . | quote }}
- name: NYLORUN_OBJECT_STORE_BUCKET
  value: {{ .Values.objectStore.bucket | quote }}
- name: NYLORUN_OBJECT_STORE_REGION
  value: {{ .Values.objectStore.region | quote }}
- name: NYLORUN_OBJECT_STORE_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ include "nylorun.objectStore.secret" . }}, key: accessKey } }
- name: NYLORUN_OBJECT_STORE_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ include "nylorun.objectStore.secret" . }}, key: secretKey } }
{{- end -}}

{{- define "nylorun.placement" -}}
{{- with .Values.placement.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.placement.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "nylorun.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "nylorun.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
{{- end -}}
