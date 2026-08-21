# Liaoning deployment

This deployment runs the source from `omgwowai/deepseek-harness` at commit
`47f943859bef60e4160492346772ded9b24f765a` in `mc-tianhai-feng`. It persists
the build, sessions, settings, and workspace under `ch-home/deepseek-harness`.

The `gateway` sidecar serves two purposes:

- Basic authentication and browser security headers in front of the Web UI.
- TokenRouter credential injection on loopback. The Harness container receives
  only a dummy credential and does not mount the Secret or a service-account
  token.

Create the `deepseek-harness-secrets` Secret before applying
`liaoning.yaml`; it must contain `htpasswd`. Create the separate
`deepseek-harness-model-key` Secret with `tokenrouter-key`, sourced from the
Codex credential store without placing it in command arguments or a temporary
file. Do not put either value in Git.

The service is reachable from the trusted internal network at
`http://192.168.2.37:32185/`. The deployment intentionally does not expose the
Harness listener directly because its CLI only supports loopback binding.

The Liaoning kernel does not provide a usable Harness sandbox backend. Bash is
therefore enabled with `danger-full-access` inside a non-root container that
has no service-account token, a read-only root filesystem, read-only source,
and only the dedicated workspace and Harness home mounted writable.

Creation mode is enabled for authenticated users. Its dynamic Cordis packages
have the same authority as shell commands inside the Harness container, and
packages with a browser half require approval from an open authenticated page.
The unattended workflow worker and code runtime remain disabled.
