# Protocol Capture Notes

This document records protocol observations from local Fiddler captures. Do not
commit raw `.saz` files, auth codes, tickets, cookies, QQ numbers, or full
payload dumps.

## 2026-06-18 QQ Desktop Capture

Captured gateway:

```text
wss://gate-obt.nqf.qq.com/prod/ws?platform=qq&os=Windows&ver=1.12.1.6_20260609&code=[REDACTED]&openID=
```

Observed page frame:

```text
https://appservice.qq.com/1112386029/pc-v3.3.11/page-frame.html
```

Observed startup and UI-adjacent services:

- `gamepb.userpb.UserService.Login`
- `gamepb.userpb.UserService.Heartbeat`
- `gamepb.userpb.UserService.GetUserSettings`
- `gamepb.userpb.UserService.SetDisplayInfo`
- `gamepb.userpb.UserService.BatchClientReportFlow`
- `gamepb.plantpb.PlantService.AllLands`
- `gamepb.dogpb.DogService.GetDogInfo`
- `gamepb.skinpb.SkinService.SkinsOwned`
- `gamepb.skinpb.SkinService.SkinsEquipped`
- `gamepb.avatarframepb.AvatarFrameService.AvatarFramesOwned`
- `gamepb.activitypb.ActivityService.List`
- `gamepb.seasonpb.SeasonService.GetSeasonInfo`
- `gamepb.solartermspb.SolarTermsService.GetSolarTermsRedDot`
- `gamepb.emailpb.EmailService.GetEmailList`
- `gamepb.sharepb.ShareService.GetInviteInfo`
- `gamepb.paypb.PayService.GetRechargeInfo`
- `gamepb.bulletinboardpb.BulletinBoardService.GetBulletinList`
- `gamepb.marqueepb.MarqueeService.GetMarquee`
- `gamepb.rechargebonuspb.RechargeBonusService.GetConfig`
- `gamepb.randomdroppb.RandomDropService.GetActivityInfo`
- `gamepb.interactpb.InteractService.GetInteractInfo`
- `gamepb.uicproxypb.UicprotoxyService.BatchModerateText`
- `gamepb.friendpb.FriendService.GetShareKey`
- `gamepb.friendpb.FriendService.SyncAll`
- `gamepb.friendpb.FriendService.GetGameFriends`
- `gamepb.mallpb.MallService.GetMallListBySlotType`
- `gamepb.shoppb.ShopService.ShopInfo`
- `gamepb.illustratedpb.IllustratedService.GetIllustratedListV2`
- `gamepb.redpacketpb.RedPacketService.GetTodayClaimStatus`
- `gamepb.qqvippb.QQVipService.GetDailyGiftStatus`

Observed risk-control service:

- `gamepb.acepb.AceService.AntiData`

Do not simulate or replay `AceService.AntiData` blindly. Treat it as an
environment/risk-control exchange and prefer conservative scheduling, low
concurrency, and real client captures before adding any behavior that depends on
it.

Implemented read-only modules:

- Dog info: `DogService.GetDogInfo`
- Skin/dress-up ownership: `SkinService.SkinsOwned`
- Skin/dress-up equipped state: `SkinService.SkinsEquipped`
- Avatar frame ownership: `AvatarFrameService.AvatarFramesOwned`

Pending captures:

- Personal career module: no complete request/reply pair captured yet.
- Golden bug dedicated protocol: no complete request/reply pair captured yet.

## Decoder

Use the local decoder for Fiddler `_w.txt` WebSocket exports:

```bash
node tools/decode-fiddler-ws.js "%TEMP%/qqfarm-saz-184918/raw/378_w.txt" "%TEMP%/decoded-378.json"
```

The decoder:

- Parses Fiddler WebSocket message headers.
- Removes WebSocket framing and unmasks client frames.
- Decodes `gatepb.Message` metadata.
- Uses `core/src/utils/tsdk.wasm` to decrypt client request bodies.
- Redacts raw text/hex values by default.

Pass `--raw-values` only for local inspection when you understand the privacy
risk.
