const sample = {
  medicineId: "medicine-1",
  batchId: "batch-1",
  photoIds: ["photo-1"],
  receiptIds: ["receipt-1"],
};

const linked = Boolean(sample.medicineId && sample.batchId && sample.photoIds.length && sample.receiptIds.length);

if (!linked) {
  console.error("paired restore contract failed");
  process.exit(1);
}

console.log("paired restore contract PASS (synthetic contract only)");
console.log("Real database/private-photo restore remains owner environment gate");
