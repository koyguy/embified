# Oracle Cloud Shell launcher

```bash
bash <(curl -fsSL https://koyguy.github.io/embified/install/oci-launch.sh)            # launch
bash <(curl -fsSL https://koyguy.github.io/embified/install/oci-launch.sh) --dry-run  # preview, creates nothing
```

Run in **Oracle Cloud Shell** (console → `>_` → Cloud Shell). It uses Cloud Shell's built-in,
already-authenticated `oci` CLI, so no API keys are created and nothing leaves the tenancy.

What it does (idempotent; re-running resumes):

1. Detects tenancy (`$OCI_TENANCY` / CLI config) and **home region**; all calls use `--region <home>`.
2. Creates or reuses compartment **`embified`**.
3. Creates or reuses `~/.ssh/embified_ed25519`; generates a 24-char inbox password
   (kept in `~/.embified/inbox-password`; on a fresh Cloud Shell it is read back from the stack).
4. Downloads the stack zip from the `orm-stack` release and creates/updates the Resource
   Manager stack **`embified-vault`** with `compartment_ocid`, `region`, `ssh_public_key`,
   `embified_auth_password`, `shape`, `availability_domain`, `ocpus`, `memory_in_gbs`.
5. Runs an auto-approved apply job and polls it. On **"Out of host capacity"** it tries the
   next availability domain, then falls back from `VM.Standard.A1.Flex` (2 OCPU / 12 GB) to
   `VM.Standard.E2.1.Micro`. If the last apply already succeeded, it skips straight to step 6.
6. Reads `public_ip` from the job's Terraform state, then polls `http://IP/api/digest/health`
   (up to 15 min) until `publicUrl` (the https trycloudflare link) appears.
7. Prints a final box with the vault link and the inbox password (the only time a secret is
   printed) and writes them to `~/embified-vault.txt` (mode 600).

`site/install/oci-launch.sh` is a copy served by GitHub Pages — keep both identical.

## Tests (no Oracle account needed)

```bash
shellcheck scripts/oci-cloudshell/oci-launch.sh
bash scripts/oci-cloudshell/test/run.sh
```

`test/bin/oci` is a fake CLI and `test/bin/curl` fakes the health endpoint. Covered: dry run
(no writes), success on A1, re-run idempotency (no new job, same password, password recovered
from the stack), A1 capacity → E2.1.Micro fallback, and no capacity anywhere.
Not covered: real Oracle API behaviour (exact CLI output shapes, Cloud Shell env, whether
`stack get` returns the sensitive password variable, job log wording).
