"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const supabaseClientPath = require.resolve("@supabase/supabase-js");
const supabaseModulePath = require.resolve("../lib/supabase");
const originalSupabaseClientExports = require("@supabase/supabase-js");
const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_KEY;

let activeClient = null;
const clientFacade = {
  get storage() {
    return activeClient.storage;
  },
  from(...args) {
    return activeClient.from(...args);
  },
};

require.cache[supabaseClientPath].exports = {
  ...originalSupabaseClientExports,
  createClient: () => clientFacade,
};
process.env.SUPABASE_URL = "https://storage-cleanup.test";
process.env.SUPABASE_SERVICE_KEY = "storage-cleanup-test-key";
delete require.cache[supabaseModulePath];
const supa = require("../lib/supabase");
require.cache[supabaseClientPath].exports = originalSupabaseClientExports;

test.after(() => {
  delete require.cache[supabaseModulePath];
  if (previousUrl == null) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = previousUrl;
  if (previousKey == null) delete process.env.SUPABASE_SERVICE_KEY;
  else process.env.SUPABASE_SERVICE_KEY = previousKey;
});

function reportRowQuery(row, onDelete) {
  return {
    select() {
      return {
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
    },
    delete() {
      return {
        eq: async (_field, id) => {
          onDelete(id);
          return { error: null };
        },
      };
    },
  };
}

function captureWarnings(t) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = originalWarn;
  });
  return warnings;
}

test("single-file deletion preserves metadata when Storage remove fails", async (t) => {
  let deletedId = null;
  const warnings = captureWarnings(t);
  activeClient = {
    storage: {
      from: () => ({
        remove: async () => ({
          data: null,
          error: {
            code: "temporarily_unavailable",
            statusCode: 503,
            message: "private/user-id/report.docx unavailable",
          },
        }),
      }),
    },
    from: () =>
      reportRowQuery(
        { id: "file-1", bucket: "private-reports", object_path: "user-id/report.docx" },
        (id) => {
          deletedId = id;
        },
      ),
  };

  await assert.rejects(
    () => supa.deleteReportFile("user-1", "file-1"),
    (error) => {
      assert.match(error.message, /deleteReportFile\(storage:private-reports\): remove failed/);
      assert.match(error.message, /status=503/);
      assert.doesNotMatch(error.message, /user-id\/report\.docx/);
      return true;
    },
  );
  assert.equal(deletedId, null, "DB metadata must remain available for a later retry");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /metadata 보존/);
  assert.doesNotMatch(warnings[0], /user-id\/report\.docx/);
});

test("single-file deletion treats an already-missing object as idempotent success", async () => {
  let deletedId = null;
  activeClient = {
    storage: {
      from: () => ({
        remove: async () => ({
          data: null,
          error: { code: "object_not_found", statusCode: 404, message: "Object not found" },
        }),
      }),
    },
    from: () =>
      reportRowQuery(
        { id: "file-2", bucket: "private-reports", object_path: "gone.docx" },
        (id) => {
          deletedId = id;
        },
      ),
  };

  assert.equal(await supa.deleteReportFile("user-1", "file-2"), true);
  assert.equal(deletedId, "file-2");
});

test("a missing bucket is not mistaken for an already-missing object", async (t) => {
  let deleted = false;
  captureWarnings(t);
  activeClient = {
    storage: {
      from: () => ({
        remove: async () => ({
          data: null,
          error: { code: "not_found", statusCode: 404, message: "Bucket not found" },
        }),
      }),
    },
    from: () =>
      reportRowQuery(
        { id: "file-bucket", bucket: "missing-bucket", object_path: "report.docx" },
        () => {
          deleted = true;
        },
      ),
  };

  await assert.rejects(
    () => supa.deleteReportFile("user-1", "file-bucket"),
    /remove failed.*status=404/,
  );
  assert.equal(deleted, false);
});

test("single-file deletion fails closed on an unverifiable remove response", async (t) => {
  let deleted = false;
  captureWarnings(t);
  activeClient = {
    storage: { from: () => ({ remove: async () => ({ data: [] }) }) },
    from: () =>
      reportRowQuery(
        { id: "file-3", bucket: "private-reports", object_path: "file-3.docx" },
        () => {
          deleted = true;
        },
      ),
  };

  await assert.rejects(
    () => supa.deleteReportFile("user-1", "file-3"),
    /invalid remove response/,
  );
  assert.equal(deleted, false);
});

test("expired cleanup deletes metadata only for buckets whose objects were removed", async (t) => {
  const rows = [
    { id: "expired-a", bucket: "bucket-a", object_path: "user-a/a.docx" },
    { id: "expired-b", bucket: "bucket-b", object_path: "user-b/b.docx" },
  ];
  const removedBuckets = [];
  const deletedIds = [];
  const warnings = captureWarnings(t);

  activeClient = {
    storage: {
      from: (bucket) => ({
        remove: async () => {
          removedBuckets.push(bucket);
          if (bucket === "bucket-b") {
            return {
              data: null,
              error: { code: "timeout", statusCode: 504, message: "user-b/b.docx timed out" },
            };
          }
          return { data: [{ name: "a.docx" }], error: null };
        },
      }),
    },
    from: () => ({
      select() {
        return {
          lte() {
            return this;
          },
          limit: async () => ({ data: rows, error: null }),
        };
      },
      delete() {
        return {
          in: async (_field, ids) => {
            deletedIds.push(...ids);
            return { error: null };
          },
        };
      },
    }),
  };

  await assert.rejects(
    () => supa.cleanupExpiredReportFiles(10),
    /metadata 1건을 보존했습니다/,
  );
  assert.deepEqual(removedBuckets.sort(), ["bucket-a", "bucket-b"]);
  assert.deepEqual(deletedIds, ["expired-a"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /metadata 보존/);
  assert.doesNotMatch(warnings[0], /user-b\/b\.docx/);
});

test("overflow cleanup keeps failed rows retryable while listReportFiles still returns", async (t) => {
  const activeRows = [
    { id: "keep", bucket: "private-reports", object_path: "keep.docx" },
    { id: "overflow-1", bucket: "private-reports", object_path: "overflow-1.docx" },
    { id: "overflow-2", bucket: "private-reports", object_path: "overflow-2.docx" },
    { id: "overflow-3", bucket: "private-reports", object_path: "overflow-3.docx" },
  ];
  const listedRows = [{ id: "keep", filename: "keep.docx" }];
  const deletedIds = [];
  const warnings = captureWarnings(t);

  activeClient = {
    storage: {
      from: () => ({
        remove: async () => ({
          data: null,
          error: { code: "service_unavailable", statusCode: 503, message: "remove failed" },
        }),
      }),
    },
    from: () => ({
      select(columns) {
        let mode = "";
        return {
          eq() {
            mode = "active";
            return this;
          },
          gt() {
            return this;
          },
          order() {
            return this;
          },
          lte() {
            mode = "expired";
            return this;
          },
          limit: async () => {
            if (mode === "expired") return { data: [], error: null };
            if (String(columns).includes("bucket")) {
              return { data: activeRows, error: null };
            }
            return { data: listedRows, error: null };
          },
        };
      },
      delete() {
        return {
          in: async (_field, ids) => {
            deletedIds.push(...ids);
            return { error: null };
          },
        };
      },
    }),
  };

  assert.deepEqual(await supa.listReportFiles("user-1", 3), listedRows);
  assert.deepEqual(deletedIds, [], "failed overflow rows must stay in the DB for retry");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cleanupOverflowReportFiles/);
  assert.match(warnings[0], /metadata 보존/);
});

test("failed metadata insert reports a failed Storage rollback instead of hiding an orphan", async (t) => {
  const warnings = captureWarnings(t);

  activeClient = {
    storage: {
      getBucket: async () => ({ data: { id: "generated-reports" }, error: null }),
      updateBucket: async () => ({ data: {}, error: null }),
      from: () => ({
        upload: async () => ({ data: {}, error: null }),
        remove: async () => ({
          data: null,
          error: { code: "service_unavailable", statusCode: 503, message: "private path" },
        }),
      }),
    },
    from: () => ({
      select() {
        return {
          lte() {
            return this;
          },
          limit: async () => ({ data: [], error: null }),
        };
      },
      insert() {
        return {
          select() {
            return this;
          },
          single: async () => ({ data: null, error: { message: "insert unavailable" } }),
        };
      },
    }),
  };

  await assert.rejects(
    () =>
      supa.saveReportFile({
        userId: "user-1",
        jobId: "job-1",
        reportType: "chem-pre",
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from("test"),
      }),
    (error) => {
      assert.match(error.message, /saveReportFile\(db\): insert unavailable/);
      assert.match(error.message, /saveReportFile\(rollback\)\(storage:generated-reports\)/);
      assert.match(error.message, /status=503/);
      assert.doesNotMatch(error.message, /user-1\/job-1/);
      return true;
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rollback도 실패/);
});
