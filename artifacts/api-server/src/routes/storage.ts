import { Router, type IRouter, type Response } from "express";
import { Readable } from "stream";
import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireRole, type AuthedRequest } from "../middlewares/auth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// ─── Local uploads directory ───────────────────────────────────────────────
const LOCAL_UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(LOCAL_UPLOADS_DIR)) {
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
}

// multer: keep file in memory so we can write it to both disk and bucket
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Allowed: JPEG, PNG, WebP, GIF."));
    }
  },
});

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 *
 * Restricted to admins and restaurant owners (the only roles that need to
 * upload restaurant/menu images).
 */
router.post(
  "/storage/uploads/request-url",
  requireRole("admin", "super_admin", "manager", "restaurant_owner"),
  async (req: AuthedRequest, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    const { name, size, contentType } = parsed.data;

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      res.status(400).json({
        error: "Unsupported file type. Allowed: JPEG, PNG, WebP, GIF.",
      });
      return;
    }

    if (size > MAX_UPLOAD_BYTES) {
      res.status(400).json({
        error: `File too large. Maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
      });
      return;
    }

    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * POST /storage/uploads/server
 *
 * Server-side upload: receives a multipart file, saves it to the local
 * `./uploads/` directory AND uploads it to the Replit object-storage bucket
 * in parallel. Returns both paths so callers can use either.
 *
 * Restricted to admins and restaurant owners (same as presigned-URL flow).
 */
router.post(
  "/storage/uploads/server",
  requireRole("admin", "super_admin", "manager", "restaurant_owner"),
  upload.single("file"),
  async (req: AuthedRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded." });
        return;
      }

      const { buffer, mimetype, originalname } = req.file;
      const objectId = randomUUID();
      const ext = originalname.split(".").pop() ?? "bin";
      const localFileName = `${objectId}.${ext}`;
      const localFilePath = path.join(LOCAL_UPLOADS_DIR, localFileName);

      // Save locally and upload to bucket in parallel
      const [bucketPath] = await Promise.all([
        objectStorageService.uploadBuffer(buffer, mimetype, objectId).catch((err) => {
          req.log.warn({ err }, "Bucket upload failed, returning local path only");
          return null;
        }),
        fs.promises.writeFile(localFilePath, buffer),
      ]);

      res.json({
        localPath: `/uploads/${localFileName}`,
        bucketPath: bucketPath ?? null,
        objectPath: bucketPath ?? `/uploads/${localFileName}`,
        metadata: { name: originalname, size: buffer.length, contentType: mimetype },
      });
    } catch (error) {
      req.log.error({ err: error }, "Server-side upload failed");
      res.status(500).json({ error: "Upload failed" });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication checks.
 */
router.get("/storage/public-objects/*filePath", async (req: AuthedRequest, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve uploaded restaurant/menu images from PRIVATE_OBJECT_DIR. Reads are
 * open so customers can view restaurant/menu images without authentication;
 * writes are gated by the upload endpoint above.
 */
router.get("/storage/objects/*path", async (req: AuthedRequest, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
