# Native Chat memory comparison

This opt-in workload uses a fresh scaffold profile and synthetic PDF/chat fixtures.
It never calls a model provider and never opens the normal Zotero library.
Configure the Zotero binary in `.env` before running it.

```sh
node scripts/measure-chat-memory.mjs baseline 3
# Apply the production change, keeping the measurement workload identical.
node scripts/measure-chat-memory.mjs optimized 3
```

Each run opens and closes one warmup reader, measures eight further reader cycles, then streams 40 ordinary Chat turns of 120 deterministic chunks each.
The runner rejects incomplete workloads and refuses to overwrite an existing run log.
It overrides the scaffold's broad shutdown command so only the process launched by that run is terminated.
Do not run another native suite in the same checkout, edit the measured source, or run heavy jobs during a comparison.

Results are saved under `tmp/issue-469/<label>/`:

- `metadata.json` records the base commit, measured source hash, host, and workload.
- `production.diff` records tracked source changes, including the shared instrumentation.
- `run-N.json` records the built bundle hash, exact memory samples in bytes, panel counts, and rendering measurements.
- `run-N-rss.json` records primary-process resident memory sampled externally every 200 ms.
- `run-N.log` records native workflow execution and failures.

Compare repeated runs using the median and minimum/maximum, including growth from each run's own warm baseline.
Allocated heap, JavaScript GC heap, and resident memory describe different quantities and must be reported separately.
Samples labeled `post-gc` wait for Gecko's memory-minimization callback; samples labeled `pre-gc` do not trigger collection.
The sampled RSS maximum is a lower bound on the true peak, not a continuous profiler measurement.
Resident memory includes Zotero/PDF rendering and native allocations; it is not plugin-exclusive RAM.
Refresh-call timing excludes scheduled rendering work, while frame latency includes scheduling but does not establish compositor completion.
The default native suite separately checks ordinary Chat's rendering and lifecycle invariants in `chatRenderingReuse.workflow.test.ts`.
