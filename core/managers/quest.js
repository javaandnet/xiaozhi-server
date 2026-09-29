import { logger } from '../../utils/logger.js';
import QuestModel from '../models/quest.js';

/**
 * Quest管理器
 * 管理对话任务/话题的生命周期
 */
class QuestManager {
    constructor() {
        this.quests = new Map();                      // questId -> QuestModel
        this.clientActiveQuest = new Map();           // clientId -> activeQuestId
        this.clientQuests = new Map();                // clientId -> [questIds]
        this.maxQuests = 5000;                        // 最大Quest数量
        this.questTimeout = 1800000;                  // Quest超时时间（30分钟）
    }

    /**
     * 创建新的Quest
     * @param {Object} questData - Quest数据
     * @returns {QuestModel} 创建的Quest
     */
    createQuest(questData) {
        try {
            const validation = QuestModel.validate(questData);
            if (!validation.valid) {
                throw new Error(`Quest数据验证失败: ${validation.errors.join(', ')}`);
            }

            // 检查Quest数量限制
            if (this.quests.size >= this.maxQuests) {
                this.cleanupExpiredQuests();
                if (this.quests.size >= this.maxQuests) {
                    throw new Error(`Quest数量已达上限: ${this.maxQuests}`);
                }
            }

            const quest = new QuestModel(questData);
            this.quests.set(quest.questId, quest);

            // 更新客户端Quest映射
            if (!this.clientQuests.has(quest.clientId)) {
                this.clientQuests.set(quest.clientId, []);
            }
            this.clientQuests.get(quest.clientId).push(quest.questId);

            // 设置为客户端的活跃Quest
            this.clientActiveQuest.set(quest.clientId, quest.questId);

            logger.info(`Quest创建成功: ${quest.questId} (${quest.clientId})`);
            return quest;
        } catch (error) {
            logger.error(`创建Quest失败:`, error);
            throw error;
        }
    }

    /**
     * 获取Quest
     * @param {string} questId - Quest ID
     * @returns {QuestModel|null}
     */
    getQuest(questId) {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.updateActivity();
            return quest;
        }
        return null;
    }

    /**
     * 获取客户端的活跃Quest
     * @param {string} clientId - 客户端ID
     * @returns {QuestModel|null}
     */
    getActiveQuest(clientId) {
        const activeQuestId = this.clientActiveQuest.get(clientId);
        if (activeQuestId) {
            const quest = this.quests.get(activeQuestId);
            if (quest && quest.isActive()) {
                quest.updateActivity();
                return quest;
            } else {
                // 活跃Quest已关闭或不存在，清除映射
                this.clientActiveQuest.delete(clientId);
            }
        }
        return null;
    }

    /**
     * 获取或创建活跃Quest
     * 如果存在活跃Quest则返回，否则创建新的
     * @param {string} clientId - 客户端ID
     * @param {Object} questData - 创建新Quest时的数据
     * @returns {QuestModel}
     */
    getOrCreateActiveQuest(clientId, questData = {}) {
        let quest = this.getActiveQuest(clientId);
        if (!quest) {
            quest = this.createQuest({
                ...questData,
                clientId
            });
        }
        return quest;
    }

    /**
     * 关闭Quest
     * @param {string} questId - Quest ID
     * @param {string} summary - 可选摘要
     * @returns {QuestModel|null}
     */
    closeQuest(questId, summary = '') {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.close(summary);

            // 如果这是客户端的活跃Quest，清除映射
            const activeQuestId = this.clientActiveQuest.get(quest.clientId);
            if (activeQuestId === questId) {
                this.clientActiveQuest.delete(quest.clientId);
            }

            logger.info(`Quest关闭: ${questId}`);
            return quest;
        }
        return null;
    }

    /**
     * 关闭客户端的活跃Quest
     * @param {string} clientId - 客户端ID
     * @param {string} summary - 可选摘要
     * @returns {QuestModel|null}
     */
    closeActiveQuest(clientId, summary = '') {
        const activeQuestId = this.clientActiveQuest.get(clientId);
        if (activeQuestId) {
            return this.closeQuest(activeQuestId, summary);
        }
        return null;
    }

    /**
     * 暂停Quest
     * @param {string} questId - Quest ID
     * @returns {QuestModel|null}
     */
    pauseQuest(questId) {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.pause();
            logger.info(`Quest暂停: ${questId}`);
            return quest;
        }
        return null;
    }

    /**
     * 恢复Quest
     * @param {string} questId - Quest ID
     * @returns {QuestModel|null}
     */
    resumeQuest(questId) {
        const quest = this.quests.get(questId);
        if (quest && quest.status === 'paused') {
            quest.resume();
            // 设置为活跃Quest
            this.clientActiveQuest.set(quest.clientId, quest.questId);
            logger.info(`Quest恢复: ${questId}`);
            return quest;
        }
        return null;
    }

    /**
     * 增加Quest消息计数
     * @param {string} questId - Quest ID
     */
    incrementMessageCount(questId) {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.incrementMessageCount();
        }
    }

    /**
     * 获取客户端的所有Quest
     * @param {string} clientId - 客户端ID
     * @returns {QuestModel[]}
     */
    getClientQuests(clientId) {
        const questIds = this.clientQuests.get(clientId) || [];
        return questIds
            .map(id => this.quests.get(id))
            .filter(quest => quest !== undefined);
    }

    /**
     * 获取客户端的活跃Quest历史（最近N个）
     * @param {string} clientId - 客户端ID
     * @param {number} limit - 限制数量
     * @returns {QuestModel[]}
     */
    getQuestHistory(clientId, limit = 10) {
        const quests = this.getClientQuests(clientId);
        return quests
            .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
            .slice(0, limit);
    }

    /**
     * 清理过期Quest
     * @returns {number} 清理数量
     */
    cleanupExpiredQuests() {
        const now = Date.now();
        const expiredQuestIds = [];

        for (const [questId, quest] of this.quests) {
            const lastActivity = new Date(quest.lastActivity).getTime();
            if (quest.isClosed() || (now - lastActivity) > this.questTimeout) {
                expiredQuestIds.push(questId);
            }
        }

        expiredQuestIds.forEach(questId => {
            this.deleteQuest(questId);
        });

        if (expiredQuestIds.length > 0) {
            logger.info(`清理过期Quest: ${expiredQuestIds.length}个`);
        }

        return expiredQuestIds.length;
    }

    /**
     * 删除Quest
     * @param {string} questId - Quest ID
     */
    deleteQuest(questId) {
        const quest = this.quests.get(questId);
        if (quest) {
            // 从客户端Quest列表中移除
            const clientQuests = this.clientQuests.get(quest.clientId);
            if (clientQuests) {
                const index = clientQuests.indexOf(questId);
                if (index > -1) {
                    clientQuests.splice(index, 1);
                }
            }

            // 如果是活跃Quest，清除映射
            const activeQuestId = this.clientActiveQuest.get(quest.clientId);
            if (activeQuestId === questId) {
                this.clientActiveQuest.delete(quest.clientId);
            }

            this.quests.delete(questId);
        }
    }

    /**
     * 获取统计信息
     * @returns {Object}
     */
    getStats() {
        let activeCount = 0;
        let pausedCount = 0;
        let closedCount = 0;

        for (const quest of this.quests.values()) {
            if (quest.status === 'active') activeCount++;
            else if (quest.status === 'paused') pausedCount++;
            else if (quest.status === 'closed') closedCount++;
        }

        return {
            total: this.quests.size,
            active: activeCount,
            paused: pausedCount,
            closed: closedCount,
            clients: this.clientQuests.size,
            maxQuests: this.maxQuests
        };
    }

    /**
     * 设置Quest标题
     * @param {string} questId - Quest ID
     * @param {string} title - 标题
     */
    setQuestTitle(questId, title) {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.setTitle(title);
        }
    }

    /**
     * 设置Quest摘要
     * @param {string} questId - Quest ID
     * @param {string} summary - 摘要
     */
    setQuestSummary(questId, summary) {
        const quest = this.quests.get(questId);
        if (quest) {
            quest.setSummary(summary);
        }
    }
}

// 单例模式
let questManager = null;

export const initializeQuestManager = () => {
    if (!questManager) {
        questManager = new QuestManager();
        logger.info('QuestManager已初始化');
    }
    return questManager;
};

export const getQuestManager = () => {
    return questManager || initializeQuestManager();
};

export default QuestManager;
