type PushResult =
  | { kind: "accepted" }
  | { kind: "retry"; status: number | null }
  | { kind: "failed"; status: number };

export async function pushMessage(
  accessToken: string,
  recipientId: string,
  text: string,
  retryKey: string,
): Promise<PushResult> {
  if (text.length === 0 || text.length > 5_000) {
    throw new Error("LINE message must contain between 1 and 5000 UTF-16 code units");
  }

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({
        to: recipientId,
        messages: [{ type: "text", text }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (
      response.status === 200 ||
      (response.status === 409 && response.headers.has("x-line-accepted-request-id"))
    ) {
      return { kind: "accepted" };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: "retry", status: response.status };
    }
    return { kind: "failed", status: response.status };
  } catch {
    return { kind: "retry", status: null };
  }
}
