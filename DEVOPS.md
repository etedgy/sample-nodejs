# DevOps / DevSecOps writeup

End-to-end CI/CD + GitOps for `sample-nodejs`. This document explains **what**
was built and **why**, and gives a runbook to reproduce the deployment.

- **App repo (this):** source, `Dockerfile`, CI/CD pipeline.
- **GitOps repo:** [`sample-nodejs-gitops`](https://github.com/etedgy/sample-nodejs-gitops) — Helm chart + ArgoCD `Application` (the cluster's desired state).

## Architecture

```
 Developer ──PR──▶ main
                   │
                   ▼  GitHub Actions (.github/workflows/ci.yml)
   ┌───────────────────────────────────────────────────────────┐
   │ 1 test    npm ci + smoke tests                             │
   │ 2 sast    Semgrep (fails on ERROR-severity findings)       │
   │ 3 version compute next semver from git tags                │
   │ 4 build   Buildx image ──▶ Trivy scan (block HIGH/CRITICAL)│
   │           └▶ push multi-arch to GHCR (private) + git tag   │
   │ 5 deploy  bump image.tag in GitOps repo (commit)           │
   └───────────────────────────────────────────────────────────┘
                   │
                   ▼
             ArgoCD (watches GitOps repo) ──auto-sync──▶ Kubernetes
                                                          Ingress ▶ /my-app
```

## Key decisions (and why)

### Deployment vs StatefulSet → **Deployment**
The app is **stateless**: no persistent volumes, no leader/ordinal identity, no
per-pod storage. The only in-memory state is a Prometheus counter, which is
per-replica by design and scraped. Deployment gives us cheap horizontal scaling,
rolling updates, and fast rescheduling. StatefulSet's ordered/stable-identity
guarantees would be pure overhead here.

### Helm chart features
`Deployment` (2 replicas) · `Service` (ClusterIP) · `Ingress` (nginx) ·
`ConfigMap` (non-secret config → env) · `Secret` (illustrative sensitive env) ·
`ServiceAccount` (token automount disabled) · optional `HPA` (bonus).
Plus: **readiness** (`/ready`) and **liveness** (`/live`) probes, CPU/memory
**requests and limits**, a hardened **securityContext** (non-root, read-only
root FS, all caps dropped, `RuntimeDefault` seccomp), and config/secret
**checksum annotations** so pods roll automatically when config changes.

### Image → **multi-stage, distroless, non-root**
`node:22-alpine` installs prod-only deps (`npm ci --omit=dev`); the runtime
stage is `gcr.io/distroless/nodejs22-debian12:nonroot`. No shell/package
manager → minimal attack surface and a near-zero CVE count, which keeps the
Trivy gate honest. Built multi-arch (amd64 + arm64) so it runs on cloud runners
and Apple-silicon kind alike.

### SAST → **Semgrep**
On the OWASP source-code-analysis list, first-class for JS/Node, no account
needed. Rulesets: `p/security-audit`, `p/nodejs`, `p/owasp-top-ten`. `--error`
makes the pipeline **fail on findings** at ERROR severity. Results are also
uploaded as SARIF to the Security tab. (CodeQL is a fine alternative; Semgrep
was chosen for a simple, hard, account-free gate.)

### Image scanning → **Trivy**
Scans OS + language dependencies. `severity: HIGH,CRITICAL` with `exit-code: 1`
**blocks deployment** — the scan runs before the image is pushed and before the
GitOps bump, so a vulnerable image never reaches the cluster. `ignore-unfixed`
avoids failing on CVEs with no available fix.

### Registry → **GHCR (private)**
Zero extra setup with GitHub Actions (`GITHUB_TOKEN` + `packages: write`),
private by default. Same tradeoff as ECR/Docker Hub without extra credentials.

### GitOps → **separate repo, ArgoCD pull**
CI pushes an `image.tag` bump to `sample-nodejs-gitops`; ArgoCD watches that
repo and syncs. Rationale in that repo's README: separation of concerns / least
privilege, a clean deploy audit trail, and no CD credentials in the app repo.
ArgoCD **pulls** (no cluster credentials in CI) with `selfHeal` + `prune`.

### Versioning / git workflow → **GitHub Flow + semver**
Trunk-based: feature branch → PR (all checks run, nothing is published) →
squash-merge to `main` → pipeline versions, publishes, deploys. Version bump is
**patch** by default; put `#minor` / `#major` (or a `feat:` prefix /
`BREAKING CHANGE`) in the merge message to bump higher. Each release creates an
immutable git tag and image tags: `vX.Y.Z`, `sha-<sha>`, `latest`.

## Reproduce the deployment (local, kind)

Prereqs: docker, kind, kubectl, helm, argocd CLI.

```bash
# 1. Cluster with an ingress-ready node (host ports 80/443 mapped)
kind create cluster --name devops --config kind/cluster.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=180s

# 2. ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3. Image pull secret for the private GHCR image (app namespace)
kubectl create namespace sample-nodejs
kubectl -n sample-nodejs create secret docker-registry ghcr-cred \
  --docker-server=ghcr.io --docker-username=<gh-user> --docker-password=<token>

# 4. Register the (private) GitOps repo with ArgoCD, then apply the Application
argocd repo add https://github.com/etedgy/sample-nodejs-gitops.git \
  --username <gh-user> --password <token>
kubectl apply -f https://raw.githubusercontent.com/etedgy/sample-nodejs-gitops/main/argocd/application.yaml

# 5. Browse
open http://localhost/my-app     # -> "Hello, World!"
```
