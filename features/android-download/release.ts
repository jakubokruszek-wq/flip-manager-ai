/** Immutable, already tested release; this endpoint never rebuilds or re-signs it. */
export type AndroidRelease = {version:string;filename:string;bytes:number;sha256:string;source:string;path:string};
export const androidRelease087 = {
  version: "0.5.87",
  filename: "flip-watcher-0.5.87-arm64.apk",
  bytes: 213802477,
  sha256: "c2c4b24e64ecbaec1104cda1e644849538023efb3826d8c180f0926d50e1ed10",
  source: "https://github.com/jakubokruszek-wq/flip-manager-ai/releases/download/gecko-poc-0.5.87/flip-watcher-0.5.87-arm64.apk",
  path: "/api/android/flip-watcher-0.5.87.apk",
} as const;

export const androidRelease088 = {
  version: "0.5.88",
  filename: "flip-watcher-0.5.88-arm64.apk",
  bytes: 213802477,
  sha256: "ec00f326ffd799746055fb9b9ec12fb093fbfd05c55a6141e92efb2cbc1b463a",
  source: "https://github.com/jakubokruszek-wq/flip-manager-ai/releases/download/gecko-poc-0.5.88/flip-watcher-0.5.88-arm64.apk",
  path: "/api/android/flip-watcher-0.5.88.apk",
} as const;
export const androidRelease: AndroidRelease = androidRelease088;
