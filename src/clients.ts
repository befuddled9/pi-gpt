// Shared lazy ChatGPT client lifecycle for Pi extensions and native providers.
import { BackendClient } from "./client.ts";
import { ConversationClient } from "./conversation.ts";

let backend: BackendClient | null = null;
let conversation: ConversationClient | null = null;

export function getChatGptClients(): { backend: BackendClient; conversation: ConversationClient } {
  if (!backend) backend = new BackendClient();
  if (!conversation) conversation = new ConversationClient(backend);
  return { backend, conversation };
}
