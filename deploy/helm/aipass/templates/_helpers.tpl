{{- define "aipass.image" -}}
{{ .root.Values.image.registry }}/aipass-{{ .name }}:{{ .root.Values.image.tag | default .root.Chart.AppVersion }}
{{- end -}}

{{- define "aipass.labels" -}}
app.kubernetes.io/name: aipass
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "aipass.selector" -}}
app.kubernetes.io/name: aipass
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "aipass.secretName" -}}
{{ .Values.secrets.existingSecret | default (printf "%s-secrets" .Release.Name) }}
{{- end -}}

{{/* Settings every aipass process reads. */}}
{{- define "aipass.env" -}}
- name: API_URL
  value: http://api:3001
- name: GATEWAY_URL
  value: {{ .Values.gatewayUrl | quote }}
- name: GATEWAY_INTERNAL_URL
  value: http://gateway:3002
- name: PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: WEB_URL
  value: {{ .Values.publicUrl | quote }}
- name: FHIR_BASE_URL
  value: {{ .Values.fhirBaseUrl | quote }}
- name: ORG_NAME
  value: {{ .Values.orgName | quote }}
- name: AIPASS_TRUSTED_PROXIES
  value: {{ join "," .Values.trustedProxies | quote }}
{{- range $key := list "DATABASE_URL" "BETTER_AUTH_SECRET" "AIPASS_VAULT_KEY" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "aipass.secretName" $ }}
      key: {{ $key }}
{{- end }}
{{- range $key := list "AIPASS_VAULT_KEY_PREVIOUS" "FHIR_AUTHORIZATION" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "aipass.secretName" $ }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- end -}}

{{- define "aipass.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "aipass.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}
