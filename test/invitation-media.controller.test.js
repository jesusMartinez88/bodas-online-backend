import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const mediaRoot = await mkdtemp(join(tmpdir(), "boda-media-test-"));
process.env.INVITATION_MEDIA_DIR = mediaRoot;
const controller = await import("../src/controllers/invitationMediaController.js");

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  end() {
    return this;
  },
});

const failNext = (error) => {
  throw error;
};

test.after(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
});

test("cover uploads are decoded and stored exclusively as WebP", async () => {
  const source = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#cc3366" },
  })
    .jpeg()
    .toBuffer();
  const req = { userContext: { slug: "test-couple" }, file: { buffer: source } };
  const res = createResponse();

  await controller.uploadCover(req, res, failNext);

  assert.equal(res.statusCode, 201);
  assert.equal(
    res.body.data.url,
    "/media/photos/test-couple/covery/cover.webp",
  );
  const coverDirectory = join(mediaRoot, "test-couple", "covery");
  const stored = await readFile(join(coverDirectory, "cover.webp"));
  assert.equal((await sharp(stored).metadata()).format, "webp");

  const replacement = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#3366cc" },
  })
    .png()
    .toBuffer();
  await controller.uploadCover(
    { userContext: { slug: "test-couple" }, file: { buffer: replacement } },
    createResponse(),
    failNext,
  );
  assert.deepEqual(await readdir(coverDirectory), ["cover.webp"]);
});

test("rejects SVG data instead of persisting the original file", async () => {
  const req = {
    userContext: { slug: "test-couple" },
    file: { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
  };
  const res = createResponse();
  let receivedError = null;

  await controller.uploadCover(req, res, (error) => {
    receivedError = error;
  });

  assert.equal(receivedError?.status, 415);
});
