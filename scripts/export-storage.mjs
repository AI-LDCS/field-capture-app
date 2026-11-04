// Runs inside the app container (see export-storage.sh): writes every object in the bucket to stdout as a
// tar file, under its own key, then a manifest.json with each object's size and SHA-256. Progress goes to stderr.
import { createHash } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { TarArchive } from "archiver";

const Bucket = process.env.S3_BUCKET;
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});

const objects = [];
let ContinuationToken;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
  objects.push(...(page.Contents ?? []));
  ContinuationToken = page.NextContinuationToken;
} while (ContinuationToken);
const total = objects.reduce((n, o) => n + o.Size, 0);
console.error(`exporting ${objects.length} objects, ${(total / 1024 ** 3).toFixed(2)} GiB, from bucket "${Bucket}"`);

const tar = new TarArchive();
const finished = new Promise((resolve, reject) => {
  process.stdout.on("error", reject);
  tar.on("error", reject);
  tar.on("warning", reject);
  tar.on("end", resolve);
});
tar.pipe(process.stdout);

const manifest = [];
for (const [i, o] of objects.entries()) {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key: o.Key }));
  const hash = createHash("sha256");
  Body.on("data", (d) => hash.update(d));
  const entryDone = new Promise((resolve, reject) => {
    Body.on("end", resolve);
    Body.on("error", reject);
  });
  // giving the size lets archiver stream the object instead of holding it in memory
  tar.append(Body, { name: o.Key, stats: { size: o.Size, mtime: o.LastModified } });
  await entryDone;
  manifest.push({ key: o.Key, bytes: o.Size, sha256: hash.digest("hex") });
  if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${objects.length}`);
}
tar.append(JSON.stringify({ bucket: Bucket, exportedAt: new Date().toISOString(), objects: manifest }, null, 2), { name: "manifest.json" });
await tar.finalize();
await finished;
