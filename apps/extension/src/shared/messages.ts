namespace ShadowShield.Messages {
  export type SetDeviceCredential = { type: "SET_DEVICE_CREDENTIAL"; token: string };
  export type GetConnectionStatus = { type: "GET_CONNECTION_STATUS" };
  export type EnqueueEvent = { type: "ENQUEUE_EVENT"; event: Record<string, unknown> };
  export type GetCoverage = { type: "GET_COVERAGE" };
  export type RequestAnalysis = { type: "ANALYZE_LOCAL"; text: string };
  export type VerifyRedaction = { type: "VERIFY_REDACTION"; originalText: string; approvedText: string; analysis: ShadowShield.Content.Analysis; warnAcknowledged: boolean };
  export type CoverageUpdate = { type: "COVERAGE_UPDATE"; coverage: CoverageStatus };
  export type Request = SetDeviceCredential | GetConnectionStatus | EnqueueEvent | GetCoverage | RequestAnalysis | VerifyRedaction | CoverageUpdate;
  export type ConnectionStatus = { connected: boolean; reconnectRequired: boolean; message: string };
  export type CoverageStatus = { mode: "SANDBOX_GUARDED" | "UNPROTECTED" | "UNSUPPORTED"; label: string };
}
