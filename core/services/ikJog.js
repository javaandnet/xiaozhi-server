/**
 * IK 微调基准（机械臂末端 jog 起点）统一维护：Web / iOS / LLM 链路共用一份。
 * 各端本地跟踪绝对位会因连续动作、多设备切换而陈旧，首次微调会"快速跳回
 * 某位再动"（危险）。基准收口到 server：无法跟踪的动作执行后置为未知，
 * 显式回位前拒绝微调。
 * 机体系符号约定（2026-10 真机三测定版，轴相对直觉旋转 90°）：
 * +y=前伸、-y=回收、-x=左移、+x=右移、+z=升高。
 */

export const IK_HOME = { x: 0, y: 6, z: 18 };
// 安全盒（cm），与派侧 arm_ik 一致：x±12 / y0~16 / z4~30
const BOX = { xAbs: 12, yMin: 0, yMax: 16, zMin: 4, zMax: 30 };

/** 方向语义 → 机体系步进（单一事实源，前端只发 dir；轴映射见文件头实测约定） */
export const IK_STEPS = {
  up: { dz: 3 }, down: { dz: -3 },
  forward: { dy: 3 }, back: { dy: -3 },
  left: { dx: -2 }, right: { dx: 2 },
};

/** bodyKey(lower) -> {x,y,z}；不在 Map 中 = 基准未知 */
const origins = new Map();

export function clampPose(p) {
  return {
    x: Math.max(-BOX.xAbs, Math.min(BOX.xAbs, Math.round(p.x * 10) / 10)),
    y: Math.max(BOX.yMin, Math.min(BOX.yMax, Math.round(p.y * 10) / 10)),
    z: Math.max(BOX.zMin, Math.min(BOX.zMax, Math.round(p.z * 10) / 10)),
  };
}

export function getOrigin(body) {
  return origins.get(String(body).toLowerCase()) || null;
}

export function setOrigin(body, pose) {
  origins.set(String(body).toLowerCase(), clampPose(pose));
}

/**
 * MCP 工具执行后回调（由 mcp.js callDeviceMcpTool 挂入）：
 * - robot_arm_ik 成功且有解：基准推进到目标位（未指定归属身体时保守清空）；
 * - robot_arm_pose / robot_press / robot_grasp（连续动作宏/多段动作）成功：末端终点未知 → 基准置未知。
 * - robot_gripper 仅控夹爪 servo1，不改变末端坐标 → 基准不受影响（故意不登记）。
 */
export function noteToolResult(toolName, args, resultText, bodyKey) {
  try {
    if (toolName !== 'robot_arm_ik' && toolName !== 'robot_arm_pose'
      && toolName !== 'robot_press' && toolName !== 'robot_grasp') return;
    let r = null;
    try { r = JSON.parse(String(resultText)); } catch { return; } // 非 JSON 结果不动基准
    if (!r || r.ok !== true) return;
    const body = bodyKey ? String(bodyKey).toLowerCase() : null;
    if (toolName === 'robot_arm_ik') {
      if (r.found === false) return; // 无解 = 臂未动
      if (body && args && Number.isFinite(Number(args.x))) setOrigin(body, args);
      else origins.clear();
    } else if (body) {
      origins.delete(body);
    } else {
      origins.clear();
    }
  } catch (e) {
    console.warn('[ikJog] noteToolResult failed:', e.message);
  }
}
