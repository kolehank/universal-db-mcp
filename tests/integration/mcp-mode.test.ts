/**
 * MCP Mode Integration Tests
 */

import { describe, it, expect } from 'vitest';
import { DatabaseMCPServer } from '../../src/mcp/mcp-server';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DbConfig } from '../../src/types/adapter';

describe('MCP Mode Integration Tests', () => {
  describe('DatabaseMCPServer', () => {
    it('should create MCP server instance', () => {
      const config: DbConfig = {
        type: 'sqlite',
        filePath: ':memory:',
        allowWrite: false
      };

      const server = new DatabaseMCPServer(config);
      expect(server).toBeDefined();
    });

    it('should start without adapter and report disconnected status', async () => {
      const config: DbConfig = {
        type: 'sqlite',
        filePath: ':memory:',
        allowWrite: false
      };

      // v2.14.0 起「无适配器无连接启动」是正式特性（mcp-server start() 不再抛
      // 「必须先设置数据库适配器」）：start() 必须正常 resolve。
      const server = new DatabaseMCPServer(config);
      await expect(server.start()).resolves.toBeUndefined();
      await server.stop(); // 释放 stdio transport 资源，避免测试进程挂起

      // 未连接状态下 get_connection_status（走 CallTool 路径）报未连接/无 source
      const unconnected = new DatabaseMCPServer(config);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'mcp-mode-test', version: '1.0.0' });
      await Promise.all([
        client.connect(clientTransport),
        unconnected.connect(serverTransport),
      ]);
      const result = await client.callTool({ name: 'get_connection_status', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0].text;
      const status = JSON.parse(text) as { connected: boolean; source: string | null };
      expect(status.connected).toBe(false);
      expect(status.source).toBeNull();
      await client.close();
      await unconnected.stop();
    });
  });
});