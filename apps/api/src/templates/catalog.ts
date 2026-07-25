import type { WorkflowIR } from '@xperiment/ir';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'sales' | 'cs' | 'ops';
  useCase: string;
  version: string;
  requiredConnectors: string[];
  definition: WorkflowIR;
}

const trigger = {
  id: 't',
  kind: 'trigger',
  type: 'webhook.trigger',
  operationVersion: '0.1.0',
  parameters: { authMode: 'none' },
} as const;

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'wa-lead-auto-reply',
    name: 'WhatsApp lead auto-reply',
    description: 'Instantly reply to a new lead on WhatsApp with a friendly greeting.',
    category: 'sales',
    useCase: 'A web form or WhatsApp lead arrives; send an automatic first response.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_lead', name: 'WhatsApp lead auto-reply' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        {
          id: 'extract',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: { name: '{{ trigger.body.body.name }}', phone: '{{ trigger.body.body.phone }}' } },
        },
        {
          id: 'reply',
          kind: 'action',
          type: 'whatsapp.sendMessage',
          operationVersion: '0.1.0',
          parameters: {
            to: '{{ trigger.body.body.phone }}',
            text: 'Halo {{ trigger.body.body.name }}, terima kasih telah menghubungi kami! Tim kami akan segera membalas.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'extract', port: 'input' } },
        { id: 'e2', from: { nodeId: 'extract', port: 'main' }, to: { nodeId: 'reply', port: 'input' } },
      ],
    },
  },
  {
    id: 'wa-order-receipt',
    name: 'WhatsApp order receipt',
    description: 'Send a WhatsApp receipt when an order is placed.',
    category: 'cs',
    useCase: 'An order webhook fires; confirm it to the customer on WhatsApp.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_receipt', name: 'WhatsApp order receipt' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        {
          id: 'format',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: { fields: { orderId: '{{ trigger.body.body.orderId }}', total: '{{ trigger.body.body.total }}' } },
        },
        {
          id: 'send',
          kind: 'action',
          type: 'whatsapp.sendMessage',
          operationVersion: '0.1.0',
          parameters: {
            to: '{{ trigger.body.body.phone }}',
            text: 'Terima kasih! Pesanan #{{ trigger.body.body.orderId }} sebesar Rp {{ trigger.body.body.total }} telah kami terima.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'format', port: 'input' } },
        { id: 'e2', from: { nodeId: 'format', port: 'main' }, to: { nodeId: 'send', port: 'input' } },
      ],
    },
  },
  {
    id: 'wa-appointment-reminder',
    name: 'WhatsApp appointment reminder',
    description: 'Remind a customer on WhatsApp when their appointment is near.',
    category: 'ops',
    useCase: 'A scheduler/webhook checks upcoming appointments; remind those within 24h.',
    version: '1.0.0',
    requiredConnectors: ['whatsapp'],
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wa_reminder', name: 'WhatsApp appointment reminder' },
      entrypoints: ['t'],
      nodes: [
        { ...trigger },
        {
          id: 'check',
          kind: 'logic',
          type: 'core.if',
          operationVersion: '0.1.0',
          parameters: { condition: '{{ trigger.body.body.hoursUntil <= 24 }}' },
        },
        {
          id: 'remind',
          kind: 'action',
          type: 'whatsapp.sendMessage',
          operationVersion: '0.1.0',
          parameters: {
            to: '{{ trigger.body.body.phone }}',
            text: 'Pengingat: Anda memiliki janji temu pada {{ trigger.body.body.appointmentTime }}. Sampai jumpa!',
          },
        },
        { id: 'skip', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { skipped: true } } },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'check', port: 'input' } },
        { id: 'e2', from: { nodeId: 'check', port: 'true' }, to: { nodeId: 'remind', port: 'input' } },
        { id: 'e3', from: { nodeId: 'check', port: 'false' }, to: { nodeId: 'skip', port: 'input' } },
      ],
    },
  },
];

export function listTemplates(category?: string): WorkflowTemplate[] {
  return category ? TEMPLATES.filter((t) => t.category === category) : TEMPLATES;
}

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
