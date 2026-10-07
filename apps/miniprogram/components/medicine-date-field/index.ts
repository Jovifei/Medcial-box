function chineseDate(value: string, precision: string): string {
  const parts = value.split("-");
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return "";
  const month = Number(parts[1]);
  if (month < 1 || month > 12) return "";
  if (precision === "month") return `${parts[0]}年${month}月`;
  if (parts.length !== 3) return "";
  const day = Number(parts[2]);
  const date = new Date(Number(parts[0]), month - 1, day);
  if (date.getFullYear() !== Number(parts[0]) || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${parts[0]}年${month}月${day}日`;
}

Component({
  properties: {
    value: { type: String, value: "" },
    precision: { type: String, value: "day" },
    label: { type: String, value: "选择日期" },
    disabled: { type: Boolean, value: false },
    allowPrecision: { type: Boolean, value: false },
    clearable: { type: Boolean, value: false },
  },
  data: { displayValue: "", pickerPrecision: "day", precisionLabels: ["仅年和月", "年、月、日"], precisionIndex: 1 },
  observers: {
    "value, precision"(value: string, precision: string): void {
      this.setData({ displayValue: chineseDate(value, precision), pickerPrecision: precision === "day" ? "day" : "month", precisionIndex: precision === "day" ? 1 : 0 });
    },
  },
  methods: {
    onClear(): void {
      if (this.properties.disabled || !this.properties.clearable) return;
      this.triggerEvent("change", { value: "", precision: this.properties.precision });
    },
    onChoosePrecision(): void {
      if (this.properties.disabled || !this.properties.allowPrecision) return;
      wx.showActionSheet({ itemList: ["仅年和月", "年、月、日"], success: (result) => {
        this.onPrecisionChange({ detail: { value: result.tapIndex } });
      } });
    },
    onPrecisionChange(event: { detail: { value: string | number } }): void {
      if (this.properties.disabled || !this.properties.allowPrecision) return;
      if (String(event.detail.value).trim() === "") return;
      const index = Number(event.detail.value);
      if (!Number.isInteger(index) || index < 0 || index > 1) return;
      const precision = index === 1 ? "day" : "month";
      const value = precision === "month" ? (this.properties.value.length !== 0 && this.properties.value.length !== 7 && chineseDate(this.properties.value, "day") === "" ? this.properties.value : this.properties.value.slice(0, 7)) : this.properties.precision === "day" ? this.properties.value : "";
      this.triggerEvent("change", { value, precision });
    },
    onDateChange(event: { detail: { value: string } }): void {
      if (this.properties.disabled) return;
      const precision = this.properties.precision === "day" ? "day" : "month";
      if (event.detail.value.length !== 7 && chineseDate(event.detail.value, "day") === "") return;
      const value = precision === "month" ? event.detail.value.slice(0, 7) : event.detail.value;
      if (chineseDate(value, precision) === "") return;
      this.triggerEvent("change", { value, precision });
    },
  },
});
