Component({
  properties: { value: { type: String, value: "" }, label: { type: String, value: "选择时间" }, disabled: { type: Boolean, value: false } },
  methods: {
    onTimeChange(event: { detail: { value: string } }): void {
      if (this.properties.disabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.detail.value)) return;
      this.triggerEvent("change", { value: event.detail.value });
    },
  },
});
