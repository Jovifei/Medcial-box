import type { FastifyInstance } from "fastify";
import { requireFamily } from "../auth/session.js";
import { errorBody } from "../types.js";
import { RecognitionUnavailableError, recognitionFailureMessages, type MedicineRecognitionProvider } from "../services/medicine-recognition.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_IMAGE_BYTES = 128;

function hasImageEnvelope(bytes: Buffer, mimeType: "image/jpeg" | "image/png"): boolean {
  if (bytes.length < MIN_IMAGE_BYTES) return false;
  if (mimeType === "image/jpeg") {
    return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) &&
      bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  }
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngEnd = Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]);
  return bytes.subarray(0, 8).equals(pngSignature) && bytes.lastIndexOf(pngEnd) >= bytes.length - 32;
}

export async function registerRecognitionRoutes(app: FastifyInstance, provider: MedicineRecognitionProvider): Promise<void> {
  app.post("/api/v1/recognitions/medicine", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    if (requireFamily(request, reply) === null) return;
    const input = request.body;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "请选择药盒照片"));
    }
    const { imageBase64, mimeType, purpose } = input as Record<string, unknown>;
    if ((mimeType !== "image/jpeg" && mimeType !== "image/png") || typeof imageBase64 !== "string" ||
        imageBase64.length === 0 || imageBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "仅支持不超过 4 MB 的 JPEG 或 PNG 照片"));
    }
    if (purpose !== undefined && purpose !== "box_front" && purpose !== "leaflet") {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "请选择药盒或说明书识别"));
    }
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length > MAX_IMAGE_BYTES || !hasImageEnvelope(bytes, mimeType)) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", "照片格式或大小不正确"));
    }
    try {
      return await provider.recognize(imageBase64, mimeType, purpose);
    } catch (error) {
      if (error instanceof RecognitionUnavailableError) {
        request.log.warn({ reason: error.reason, ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}) }, "medicine photo recognition unavailable");
        return reply.code(503).send(errorBody("RECOGNITION_UNAVAILABLE", recognitionFailureMessages[error.reason]));
      }
      throw error;
    }
  });
}
