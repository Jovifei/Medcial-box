export type ExpiryPrecision = "day" | "month" | "unknown";

export type QuantityUnit = "tablet" | "capsule" | "sachet" | "bottle" | "box" | "other";

export interface ExpiryValue {
  /** Keep the value as printed; a month-only date stays YYYY-MM. */
  value: string | null;
  precision: ExpiryPrecision;
}

export interface MedicationBatchSummary {
  id: string;
  lotNumber: string | null;
  expiry: ExpiryValue;
  quantity: number | null;
  unit: QuantityUnit;
  storageLocation: string | null;
  version: number;
}

export interface MedicationSummary {
  id: string;
  name: string;
  specification: string | null;
  manufacturer: string | null;
  approvalNumber: string | null;
  activeIngredients: string[];
  purposeCategory: string | null;
  leaflet: {
    purposeSummary: string | null;
    packageUsageSummary: string | null;
    contraindicationsSummary: string | null;
    precautionsSummary: string | null;
    source: string | null;
    reviewStatus: "unverified" | "matched" | "user_confirmed";
  };
  batches: MedicationBatchSummary[];
}

export interface HealthStatus {
  status: "ok" | "unavailable";
  database?: "connected" | "disconnected";
}
