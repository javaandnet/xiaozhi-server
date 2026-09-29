import SessionModel from '../models/session.js';
import { logger } from '../../utils/logger.js';

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionModel
    this.clientSessions = new Map(); // clientId -> [sessionIds]
    this.maxSessions = 1000;
    this.sessionTimeout = 300000; // 5分钟
  }

  // 创建会话
  createSession(sessionData) {
    try {
      const validation = SessionModel.validate(sessionData);
      if (!validation.valid) {
        throw new Error(`会话数据验证失败: ${validation.errors.join(', ')}`);
      }

      // 检查会话数量限制
      if (this.sessions.size >= this.maxSessions) {
        // 清理过期会话
        this.cleanupExpiredSessions();
        if (this.sessions.size >= this.maxSessions) {
          throw new Error(`会话数量已达上限: ${this.maxSessions}`);
        }
      }

      const session = new SessionModel(sessionData);
      
      this.sessions.set(session.sessionId, session);
      
      // 更新客户端会话映射
      if (!this.clientSessions.has(session.clientId)) {
        this.clientSessions.set(session.clientId, []);
      }
      this.clientSessions.get(session.clientId).push(session.sessionId);
      
      logger.info(`会话创建成功: ${session.sessionId} (${session.clientId})`);
      return session;
    } catch (error) {
      logger.error(`创建会话失败:`, error);
      throw error;
    }
  }

  // 获取会话
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.isActive()) {
      session.updateActivity();
      return session;
    }
    return null;
  }

  // 获取客户端的所有会话
  getClientSessions(clientId) {
    const sessionIds = this.clientSessions.get(clientId) || [];
    return sessionIds
      .map(id => this.sessions.get(id))
      .filter(session => session && session.isActive());
  }

  // 获取活跃会话
  getActiveSessions() {
    return Array.from(this.sessions.values()).filter(session => session.isActive());
  }

  // 更新会话活动时间
  updateSessionActivity(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.updateActivity();
      return session;
    }
    return null;
  }

  // 关闭会话
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
      
      // 从客户端会话列表中移除
      const clientSessions = this.clientSessions.get(session.clientId);
      if (clientSessions) {
        const index = clientSessions.indexOf(sessionId);
        if (index > -1) {
          clientSessions.splice(index, 1);
        }
      }
      
      logger.info(`会话关闭: ${sessionId}`);
      return session;
    }
    return null;
  }

  // 添加上下文
  addContext(sessionId, key, value) {
    const session = this.getSession(sessionId);
    if (session) {
      session.addContext(key, value);
      return session;
    }
    return null;
  }

  // 获取上下文
  getContext(sessionId, key) {
    const session = this.getSession(sessionId);
    return session ? session.getContext(key) : null;
  }

  // 清理会话
  cleanupSessions() {
    const now = new Date();
    const expiredSessions = [];
    
    for (const [sessionId, session] of this.sessions) {
      if (!session.isActive() || 
          (now - new Date(session.lastActivity)) > this.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }
    
    expiredSessions.forEach(sessionId => {
      this.closeSession(sessionId);
    });
    
    if (expiredSessions.length > 0) {
      logger.info(`清理过期会话: ${expiredSessions.length}个`);
    }
    
    return expiredSessions.length;
  }

  // 清理特定客户端的过期会话
  cleanupClientSessions(clientId) {
    const sessions = this.getClientSessions(clientId);
    const now = new Date();
    let cleanedCount = 0;
    
    sessions.forEach(session => {
      if ((now - new Date(session.lastActivity)) > this.sessionTimeout) {
        this.closeSession(session.sessionId);
        cleanedCount++;
      }
    });
    
    return cleanedCount;
  }

  // 获取统计信息
  getStats() {
    const activeSessions = this.getActiveSessions();
    const clientCount = new Set(activeSessions.map(s => s.clientId)).size;
    
    return {
      total: this.sessions.size,
      active: activeSessions.length,
      clients: clientCount,
      maxSessions: this.maxSessions
    };
  }

  // 批量关闭会话
  batchCloseSessionIds(sessionIds) {
    const results = {
      success: 0,
      failed: 0
    };
    
    sessionIds.forEach(sessionId => {
      try {
        this.closeSession(sessionId);
        results.success++;
      } catch (error) {
        results.failed++;
        logger.error(`批量关闭会话失败 ${sessionId}:`, error);
      }
    });
    
    return results;
  }
}

export default SessionManager;