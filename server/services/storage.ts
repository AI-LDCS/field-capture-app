import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config.ts";

// Path-style addressing: RustFS and MinIO serve buckets as /bucket/key, not bucket.host
export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
});
const Bucket = () => config.s3.bucket;

/** Buckets are not created for us. Safe to run on every start. */
export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: Bucket() }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: Bucket() }));
      console.log(`created bucket "${Bucket()}"`);
    } catch (e) {
      // another instance may have created it a moment ago
      await s3.send(new HeadBucketCommand({ Bucket: Bucket() })).catch(() => {
        throw e;
      });
    }
  }
}

export const putObject = (Key: string, Body: Buffer, ContentType?: string) =>
  s3.send(new PutObjectCommand({ Bucket: Bucket(), Key, Body, ContentType }));

export type ObjectRead = { body: Readable; status: number; length: number; contentRange?: string };

/** Streams an object, or a byte range of it. The caller must consume or destroy `body`. */
export async function getObject(Key: string, range?: string): Promise<ObjectRead> {
  const r = await s3.send(new GetObjectCommand({ Bucket: Bucket(), Key, Range: range }));
  return {
    body: r.Body as Readable,
    status: r.$metadata.httpStatusCode ?? 200,
    length: r.ContentLength ?? 0,
    contentRange: r.ContentRange,
  };
}

export async function readObject(Key: string): Promise<Buffer> {
  const { body } = await getObject(Key);
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

export async function deleteObjects(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
    );
  }
}

export async function listKeys(Prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix, ContinuationToken: token }));
    out.push(...(r.Contents ?? []).map((c) => c.Key!));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Multipart upload fed one part at a time (parts must be 5 MiB or more, except the last). */
export async function multipart(Key: string, ContentType: string) {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: Bucket(), Key, ContentType }));
  const parts: { PartNumber: number; ETag: string }[] = [];
  let next = 0;
  return {
    /** Parts may be sent several at once: the number is taken when the call is made, so file order is kept. */
    async part(body: Buffer) {
      const n = ++next;
      const r = await s3.send(new UploadPartCommand({ Bucket: Bucket(), Key, UploadId, PartNumber: n, Body: body }));
      parts.push({ PartNumber: n, ETag: r.ETag! });
    },
    complete: () =>
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: Bucket(),
          Key,
          UploadId,
          MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
        }),
      ),
    abort: () => s3.send(new AbortMultipartUploadCommand({ Bucket: Bucket(), Key, UploadId })).catch(() => {}),
  };
}

/** Tests only: empties and removes the bucket they created. */
export async function dropBucket() {
  await deleteObjects(await listKeys());
  await s3.send(new DeleteBucketCommand({ Bucket: Bucket() }));
}
