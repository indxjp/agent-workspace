import room from '../resources/room';
import { channel } from '@indx-workspace/app/server';

// The desk's `message` channel, as `aw generate channel message` writes it (issue #1519): every
// write of a message is published to the room its `room` field names.
// shortcut: the fixture's channel is the in-memory twin (`setAppRuntimeForTests`); real
// LISTEN/NOTIFY delivery is covered by channel.pg.test.ts.
export default channel('message', { resource: room, key: 'room' });
