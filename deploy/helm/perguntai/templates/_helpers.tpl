{{- define "perguntai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "perguntai.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "perguntai.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "perguntai.labels" -}}
app.kubernetes.io/name: {{ include "perguntai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "perguntai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "perguntai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "perguntai.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{ .Values.secret.existingSecret }}
{{- else -}}
{{ include "perguntai.fullname" . }}
{{- end -}}
{{- end -}}
