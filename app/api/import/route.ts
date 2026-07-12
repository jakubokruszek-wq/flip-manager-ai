import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();

  const { url } = body;

  return NextResponse.json({
    success: true,
    url,
  });
}