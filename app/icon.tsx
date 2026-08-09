import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#0D0F12",
          color: "#EBC158",
          display: "flex",
          fontFamily: "serif",
          fontSize: 196,
          fontWeight: 700,
          height: "100%",
          justifyContent: "center",
          letterSpacing: -16,
          width: "100%",
        }}
      >
        FM
      </div>
    ),
    size,
  );
}
