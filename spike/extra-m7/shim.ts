// Bun belum mengimplementasi v8.startupSnapshot.isBuildingSnapshot (dipanggil bson >= 7.3)
import v8 from "node:v8"
;(v8 as any).startupSnapshot.isBuildingSnapshot = () => false
