/* Generated from schemas/device.schema.json; do not edit. */

export interface DeviceHeartbeatV2 {
  contractVersion: 'v2';
  eventId: string;
  clientObservedAt: string;
  deviceId: string;
  kind: 'DEVICE_HEARTBEAT';
  extensionVersion: string;
}
