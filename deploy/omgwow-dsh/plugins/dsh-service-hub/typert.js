/**
 * dsh-service-hub 的 Host 面 Typert 清单（typert-loader 自动扫描注册）。
 */
import { z } from 'zod'

const infoSchema = z.object({
  hubUrl: z.string(),
  instanceId: z.string(),
  baseUrl: z.string(),
})

const _info$codec = { mode: 'strict', typeSymbol: 'dsh-service-hub#Info', schema: infoSchema }

export const TYPERT = {
  package: 'dsh-service-hub',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-service-hub#serviceHub/getInfo',
      service: 'serviceHub',
      namespace: 'serviceHub',
      method: 'getInfo',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _info$codec,
    },
  ],
  model: {
    services: [
      {
        description: '本地服务台服务（Hub 地址 / 实例标识 / 实例 Web 地址）。',
        summary: '本地服务台服务。',
        tags: [],
        jsDoc: '/** 本地服务台服务。 */',
        key: 'serviceHub',
        exportName: 'ServiceHubService',
        members: [],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
