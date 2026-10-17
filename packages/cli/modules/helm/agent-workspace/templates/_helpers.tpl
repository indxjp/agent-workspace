{{/*
The `to:` list of an egress rule from one `cidr` / `except` / `podSelector` / `namespace` value
block (`database`, `objectStore`, `providers`). Nothing is rendered when no peer is set, which leaves
the rule opening only its ports. `namespace` puts the podSelector in another namespace.
*/}}
{{- define "agent-workspace.egressTo" -}}
{{- $to := list }}
{{- with .cidr }}
{{- $block := dict "cidr" . }}
{{- with $.except }}
{{- $_ := set $block "except" . }}
{{- end }}
{{- $to = append $to (dict "ipBlock" $block) }}
{{- end }}
{{- with .podSelector }}
{{- $peer := dict "podSelector" (dict "matchLabels" .) }}
{{- with $.namespace }}
{{- $_ := set $peer "namespaceSelector" (dict "matchLabels" (dict "kubernetes.io/metadata.name" .)) }}
{{- end }}
{{- $to = append $to $peer }}
{{- end }}
{{- if $to }}to:{{ toYaml $to | nindent 2 }}{{ end }}
{{- end }}
