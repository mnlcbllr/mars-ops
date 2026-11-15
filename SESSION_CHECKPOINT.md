# SESSION_CHECKPOINT

## Objective
Implement MARS-OPS improvements: mission time/resource visibility, explainable candidate selection insights, mission insights dashboard, destination POV preview, and interactive what-if analysis while preserving existing architecture and behavior.

## Completed
- Session renamed for follow-up task.
- Verified existing implementation/tests/builds pass in current environment.
- Added honest "Additional science layers: none loaded..." note in Map key & data sources UI (`src/components/MissionWorkspace.tsx`).
- Inspected planning/resource/result/UI architecture for extension points.

## In Progress
- Designing and implementing core-backed candidate insights and mission breakdowns (P1, P2).

## Next Move
1. Extend Rust core (`planning.rs`, `session.rs`/types as needed) to compute per-candidate selection analysis, inclusion/exclusion reasons from actual calculations, and detailed mission time/resource breakdowns.
2. Thread new fields through report/IPC/TS types and update UI (MissionResults, insights panel/dashboard).
3. Add destination POV/preview controls in `Terrain3D` using existing terrain data.
4. Add interactive what-if (require/include candidate -> rerun) and tests.

## Decisions
- Keep calculations/explanations in Rust core; frontend renders engine results only.
- Preserve existing commands/contracts where possible; extend additively.
- Label terrain-derived POV/simulations clearly; no fabricated NASA imagery/features.
- Prefer deterministic, testable increments.

## Blockers
- No real ground-level NASA photos or additional verifiable science layers in checkout (POV must be terrain-derived/labeled).
- No `AGENT_HANDOFF.md`, `datasets/_source`, or `SHA256SUMS.txt`.

## Files Changed
- `src/components/MissionWorkspace.tsx` (science-layer availability note)
- `SESSION_CHECKPOINT.md`
