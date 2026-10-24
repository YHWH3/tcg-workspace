# SEC01: dependency findings during final certification

On 24 October 2026, the complete certificate at `0e824d7` passed 1,512 unit checks and 668 dedicated D1 checks, then failed its mandatory dependency security gate. The audit reported eight package findings, including three high-severity package findings. Several entries were propagation through the Cloudflare dependency chain, not separate vulnerabilities. The failed certificate remains retained; its successful gates do not certify the changed dependencies below.

## Targeted remediation

| Dependency | Previous | Installed | Reason and primary source |
|---|---|---|---|
| Zod | 4.6.5 | 4.6.6 | [Constrained-collection resource consumption](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The direct dependency is pinned exactly. |
| body-parser | 2.3.0 | 2.4.0 | [Compressed request handling](https://github.com/advisories/GHSA-27r3-jxmh-p828). Updated within its parent's supported dependency range. |
| fast-uri | 3.1.8 | 3.1.9 | [Scheme decoding](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [relative paths](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [host canonicalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr) and [suffix references](https://github.com/advisories/GHSA-333x-w4r6-6crp). |
| serialize-javascript | 7.1.2 | 7.1.4 | [Function serialization escaping](https://github.com/advisories/GHSA-m5mm-p8h7-m29v); the patched range starts at 7.1.3. |
| Undici | 7.29.1 | 7.30.1 | [EventSource bounds](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [integrity metadata](https://github.com/advisories/GHSA-f72v-6w45-q472) and [response encoding handling](https://github.com/advisories/GHSA-xjj6-f33q-929c). |

The body-parser update also requires qs 6.16.1, replacing 6.16.0. Package existence and registry integrity were checked before installation. The lockfile pins the resolved versions. Cloudflare Vite plugin 1.63.2, Wrangler 4.150.0, Miniflare 5.20261006.2-beta and Workerd remain at their established versions. Miniflare pins an older Undici exactly, so a narrow `miniflare → undici` override selects 7.30.1. Revisit that override when updating Miniflare to an upstream version with a patched dependency.

The direct and transitive changes require fresh source-bound compatibility, build, security, workflow and platform evidence. A zero-finding audit alone is not a complete engineering certificate. No exemption was added to the security policy. Contract v2, migrations, provider settings and website content are unchanged.

Earlier combined-run D1 failures at `0e824d7` passed independently and in an original-order diagnostic, followed by a complete unit and D1 pass. No causal link between those failures and these advisories has been established. Failed and interrupted attempts remain separate from any subsequent successful certification.

All evidence uses disposable local data. No production deployment, remote migration or provider activation is authorized by this dependency update.
