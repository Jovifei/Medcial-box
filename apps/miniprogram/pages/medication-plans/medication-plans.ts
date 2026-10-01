/**
 * 用药计划（R3 交付）：本页先建立四导航结构与登录守卫，
 * 空状态如实说明功能尚未提供，不放置不可用的按钮。
 */
Page({
  data: {
    loggedIn: false as boolean,
  },

  onShow(): void {
    this.setData({ loggedIn: hasSessionToken() });
  },

  goLogin(): void {
    wx.navigateTo({ url: "/pages/login/login" });
  },
});

/** 与 services/auth.ts 相同的会话存储键；只读不写，避免骨架页产生副作用。 */
function hasSessionToken(): boolean {
  try {
    return wx.getStorageSync("auth:token") !== "" || wx.getStorageSync("session") !== "";
  } catch {
    return false;
  }
}
