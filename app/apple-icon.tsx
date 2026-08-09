import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#0D0F12",
          color: "#EBC158",
          display: "flex",
          fontFamily: "serif",
          fontSize: 68,
          fontWeight: 700,
          height: "100%",
          justifyContent: "center",
          letterSpacing: -5,
          width: "100%",
        }}
      >
        FM
      </div>
    ),
    size,
  );
}
