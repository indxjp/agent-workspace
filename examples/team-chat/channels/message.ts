import channelResource from '@/resources/channel';
import { channel } from '@indx-workspace/app/server';

// Every write of a message, through its routes or an agent tool, is published to the channel
// its `channel` field names. Whoever may read that channel follows it at
// /api/channels/message/events?key=<the channel's id>.
export default channel('message', { resource: channelResource, key: 'channel' });
