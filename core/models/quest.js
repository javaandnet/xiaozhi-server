import BaseModel from './base.js';

/**
 * Quest模型 - 管理对话任务/话题
 * 一个Quest代表一个完整的对话话题，包含多轮对话
 */
class QuestModel extends BaseModel {
    constructor(data = {}) {
        super(data);
        this.questId = data.questId || this.generateQuestId();
        this.sessionId = data.sessionId || null;      // 关联的会话ID
        this.clientId = data.clientId || '';          // 客户端ID
        this.deviceId = data.deviceId || null;        // 设备ID
        this.status = data.status || 'active';        // active, paused, closed
        this.title = data.title || '';                 // Quest标题（可选，可由LLM生成）
        this.summary = data.summary || '';             // Quest摘要（关闭时生成）
        this.messageCount = data.messageCount || 0;    // 消息计数
        this.startTime = data.startTime || new Date();
        this.endTime = data.endTime || null;
        this.lastActivity = data.lastActivity || new Date();
        this.metadata = data.metadata || {};           // 额外元数据
        this.tags = data.tags || [];                   // 标签
    }

    /**
     * 生成Quest ID
     */
    generateQuestId() {
        return 'quest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    toJSON() {
        return {
            ...super.toJSON(),
            questId: this.questId,
            sessionId: this.sessionId,
            clientId: this.clientId,
            deviceId: this.deviceId,
            status: this.status,
            title: this.title,
            summary: this.summary,
            messageCount: this.messageCount,
            startTime: this.startTime,
            endTime: this.endTime,
            lastActivity: this.lastActivity,
            metadata: this.metadata,
            tags: this.tags
        };
    }

    /**
     * 检查Quest是否活跃
     */
    isActive() {
        return this.status === 'active';
    }

    /**
     * 检查Quest是否已关闭
     */
    isClosed() {
        return this.status === 'closed';
    }

    /**
     * 更新活动时间
     */
    updateActivity() {
        this.lastActivity = new Date();
        this.updatedAt = new Date();
    }

    /**
     * 增加消息计数
     */
    incrementMessageCount() {
        this.messageCount++;
        this.updateActivity();
    }

    /**
     * 暂停Quest
     */
    pause() {
        this.status = 'paused';
        this.updatedAt = new Date();
    }

    /**
     * 恢复Quest
     */
    resume() {
        if (this.status === 'paused') {
            this.status = 'active';
            this.updateActivity();
        }
    }

    /**
     * 关闭Quest
     * @param {string} summary - 可选的摘要
     */
    close(summary = '') {
        this.status = 'closed';
        this.endTime = new Date();
        this.summary = summary;
        this.updatedAt = new Date();
    }

    /**
     * 设置标题
     */
    setTitle(title) {
        this.title = title;
        this.updatedAt = new Date();
    }

    /**
     * 设置摘要
     */
    setSummary(summary) {
        this.summary = summary;
        this.updatedAt = new Date();
    }

    /**
     * 添加标签
     */
    addTag(tag) {
        if (!this.tags.includes(tag)) {
            this.tags.push(tag);
            this.updatedAt = new Date();
        }
    }

    /**
     * 移除标签
     */
    removeTag(tag) {
        const index = this.tags.indexOf(tag);
        if (index > -1) {
            this.tags.splice(index, 1);
            this.updatedAt = new Date();
        }
    }

    /**
     * 获取Quest持续时间（毫秒）
     */
    getDuration() {
        const end = this.endTime ? new Date(this.endTime) : new Date();
        return end - new Date(this.startTime);
    }

    /**
     * 验证Quest数据
     */
    static validate(data) {
        const errors = [];

        if (!data.clientId) {
            errors.push('客户端ID不能为空');
        }

        const validStatus = ['active', 'paused', 'closed'];
        if (data.status && !validStatus.includes(data.status)) {
            errors.push(`无效的Quest状态: ${data.status}`);
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

export default QuestModel;
