/**
 * Fleet env that `ofa-orch-h/run.sh` exports. Inlined so we spawn `pi --mode rpc`
 * directly (as the plan requires) without going through the wrapper, while
 * keeping the same high-limit profile.
 */
export function l2FleetEnv(engagementId: string, epochFile: string, profileDir: string): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: profileDir,
    PI_FLEET_ROSTER_KEY: engagementId,
    PI_FLEET_EPOCH_FILE: epochFile,
    PI_FLEET_MAX_CONCURRENCY: process.env.PI_FLEET_MAX_CONCURRENCY ?? "16",
    PI_FLEET_MAX_PARALLEL_TASKS: process.env.PI_FLEET_MAX_PARALLEL_TASKS ?? "48",
    PI_FLEET_MAX_CHAIN_STEPS: process.env.PI_FLEET_MAX_CHAIN_STEPS ?? "32",
    PI_FLEET_PER_TASK_OUTPUT_KB: process.env.PI_FLEET_PER_TASK_OUTPUT_KB ?? "100",
    PI_FLEET_MCP_MSGS_PER_TURN: process.env.PI_FLEET_MCP_MSGS_PER_TURN ?? "30",
    PI_FLEET_MAX_LANES: process.env.PI_FLEET_MAX_LANES ?? "1024",
    PI_FLEET_LANE_IDLE_MIN: process.env.PI_FLEET_LANE_IDLE_MIN ?? "720",
    PI_FLEET_LANE_MAX_TURNS: process.env.PI_FLEET_LANE_MAX_TURNS ?? "500",
    PI_FLEET_MAX_ACTIVE_BG_JOBS: process.env.PI_FLEET_MAX_ACTIVE_BG_JOBS ?? "128",
    PI_FLEET_MAX_BG_LOG_FILES: process.env.PI_FLEET_MAX_BG_LOG_FILES ?? "200",
    ...(process.env.OFA_H_TEST_SKIP_BARRIER_LEDGER
      ? { OFA_H_TEST_SKIP_BARRIER_LEDGER: process.env.OFA_H_TEST_SKIP_BARRIER_LEDGER }
      : {}),
    ...(process.env.OFA_H_TEST_BARRIER_STRAYS
      ? { OFA_H_TEST_BARRIER_STRAYS: process.env.OFA_H_TEST_BARRIER_STRAYS }
      : {}),
    ...(process.env.OFA_H_TEST_GET_STATE_DELAY_MS
      ? { OFA_H_TEST_GET_STATE_DELAY_MS: process.env.OFA_H_TEST_GET_STATE_DELAY_MS }
      : {}),
  };
}
