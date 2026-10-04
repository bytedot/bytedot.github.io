'use strict';
/* =====================================================================
 * config.js — 全局配置与共享上下文
 * 单位约定：1 单位 = 1 米，速度为 米/秒。
 * ===================================================================== */

/** 全局游戏上下文：各系统在 main.js 中创建后挂到这里，模块之间通过 G 互相访问 */
const G = {};

const CFG = {
  seed: 20261004,

  /* ---------- 城市布局 ---------- */
  city: {
    period: 120,        // 道路网格间距（街区 + 道路）
    blocks: 40,         // 每边街区数 → 城市约 4.8 km × 4.8 km
    streetW: 28,        // 普通街道总宽（含两侧人行道）
    avenueW: 44,        // 主干道总宽
    avenueEvery: 4,     // 每隔几条道路是一条主干道
    sidewalk: 5,        // 人行道宽度
    shore: 260,         // 城市外围绿地宽度，之外是海面
  },

  /* ---------- 角色 ---------- */
  hero: {
    radius: 0.85,       // 碰撞半径（以骨盆为中心）
    hipHeight: 1.0,     // 骨盆离脚底的高度
    walk: 5.5,
    sprint: 13,
    fly: 46,            // 普通飞行巡航速度  ≈ 166 km/h
    boost: 150,         // 高速飞行          ≈ 540 km/h
    hyper: 430,         // 极速冲刺          ≈ 1548 km/h（超过音速）
    flyAccel: 70,
    boostAccel: 150,
    hyperAccel: 320,
    hyperKick: 90,      // 进入极速瞬间的额外推力
    turnRateLow: 7.5,   // 低速时转向角速度 rad/s
    turnRateHigh: 1.9,  // 极速时转向角速度 rad/s（体现惯性与重量）
    smashSpeed: 18,     // 超过此速度撞建筑会直接撞穿
    slamSpeed: 55,      // 竖直向下超过此速度触地 → 地面冲击
    mach1: 343,
  },

  /* ---------- 镜头 ---------- */
  camera: {
    fovBase: 70,
    fovFast: 82,
    fovHyper: 100,
    distWalk: 5.2,
    distHover: 6.2,
    distFly: 8.0,
    distFast: 10.5,
    distHyper: 14.0,
    sensitivity: 0.0021,
  },

  /* ---------- 画面 ---------- */
  render: {
    maxPixelRatio: 1.5,
    shadowSize: 2048,
    msaa: 4,
  },

  /* ---------- 对象池容量 ---------- */
  pools: {
    dust: 3200,
    glow: 2200,
    debris: 900,
    shards: 700,
    rubble: 700,
    interiors: 2000,
    dynProps: 260,      // 每种道具的"已被撞飞"实例上限
  },
};

/* 建筑类型 */
const BK = { TOWER: 0, OFFICE: 1, APT: 2, HOUSE: 3, SHOP: 4 };

/* 立面风格（传入着色器的 aStyle.x） */
const FACADE = { GLASS: 0, OFFICE: 1, RESI: 2, HOUSE: 3, COMMERCIAL: 4, CONCRETE: 5 };

/* 破坏槽类型（写入破坏纹理） */
const HOLE = { NONE: 0, SMASH: 1, SHATTER: 2, BEAM: 3 };
