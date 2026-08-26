const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

test('生涯、删除好友与护主犬访问字段保持协议编号', async () => {
    const root = new protobuf.Root();
    await root.load([
        path.join(process.cwd(), 'src/proto/careerpb.proto'),
        path.join(process.cwd(), 'src/proto/friendpb.proto'),
        path.join(process.cwd(), 'src/proto/corepb.proto'),
        path.join(process.cwd(), 'src/proto/plantpb.proto'),
        path.join(process.cwd(), 'src/proto/userpb.proto'),
        path.join(process.cwd(), 'src/proto/visitpb.proto'),
    ], { keepCase: true });

    const career = root.lookupType('gamepb.careerpb.CareerInfoGetReply');
    const careerService = root.lookupService('gamepb.careerpb.CareerService');
    const deleteRequest = root.lookupType('gamepb.friendpb.DelFriendRequest');
    const visitReply = root.lookupType('gamepb.visitpb.EnterReply');
    assert.equal(career.fields.total_harvest_count.id, 2);
    assert.equal(career.fields.total_steal_count.id, 3);
    assert.ok(careerService.methods.CareerInfoGet);
    assert.equal(deleteRequest.fields.friend_gid.id, 1);
    assert.equal(visitReply.fields.brief_dog_info.id, 3);
});

export {};
