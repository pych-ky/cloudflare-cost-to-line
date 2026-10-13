import PostalMime, { addressParser } from "postal-mime";

const MAX_EMAIL_BYTES = 128 * 1024;

export async function readBudgetEmail(
  message: ForwardableEmailMessage,
  config: { recipient: string; sender: string; subject: string },
): Promise<{ messageId: string; subject: string }> {
  if (message.to !== config.recipient) {
    throw new Error("Unexpected budget email recipient");
  }
  if (message.rawSize > MAX_EMAIL_BYTES) {
    throw new Error("Budget email exceeds the size limit");
  }

  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Invalid budget email stream");
      }
      size += value.byteLength;
      if (size > MAX_EMAIL_BYTES) {
        await reader.cancel();
        throw new Error("Budget email exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const email = await PostalMime.parse(raw, {
    maxNestingDepth: 16,
    maxHeadersSize: 16 * 1024,
    maxRfc822NestingDepth: 1,
  });

  const fromHeaders = email.headers.filter((header) => header.key === "from");
  const subjectHeaders = email.headers.filter((header) => header.key === "subject");
  const idHeaders = email.headers.filter((header) => header.key === "message-id");
  if (fromHeaders.length !== 1 || subjectHeaders.length !== 1 || idHeaders.length !== 1) {
    throw new Error("Budget email has missing or ambiguous headers");
  }

  const from = addressParser(fromHeaders[0]!.value);
  if (
    from.length !== 1 ||
    from[0]!.group !== undefined ||
    from[0]!.address !== config.sender
  ) {
    throw new Error("Unexpected budget email sender");
  }
  if (email.subject !== config.subject) {
    throw new Error("Unexpected budget email subject");
  }
  if (
    !email.messageId ||
    email.messageId.length > 998 ||
    !/^<[^\s<>@]+@[^\s<>@]+>$/.test(email.messageId)
  ) {
    throw new Error("Budget email must have a valid Message-ID");
  }

  // Sender headers are untrusted; the caller verifies the threshold with Billing API.
  return { messageId: email.messageId, subject: email.subject };
}
