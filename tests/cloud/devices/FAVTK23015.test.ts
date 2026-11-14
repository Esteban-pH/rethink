import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FAVTK23015'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'FAVTK23015'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance on 2026-11-14, each cross-checked
// against the LG cloud's own decoded washerDryer state at the matching timestamp. The comments name
// the cloud fields that confirmed each one.

// Powered off, as the 0xEB snapshot the washer sent when the cloud asked on reconnect:
// cloud state:"POWEROFF", preState:"INITIAL", TCLCount:24.
const EB_POWER_OFF = buf('AA2A20EB002200000000000000000000000000000000000003053318150000000000000402022D1EE9BB')

// Cotton selected after power on: cloud course:"COTTON", state:"INITIAL", remain and initial time 47,
// soilWash:"SOILWASH_NORMAL", spin:"SPIN_1100", temp:"TEMP_40", rinse:"RINSE_NORMAL".
const COTTON = buf(
    'AA4E20EC002205000000000000000000000000000000000000003318150000000000000402022D1E002205002F002F0700020503010000000000400000003318150000000000000402022D1E3DBB',
)

// Cotton Eco: cloud course:"COTTON_ECO", remainTimeHour:2, remainTimeMinute:39.
const COTTON_ECO = buf(
    'AA4E20EC002205002F002F0700020503010000000000400000003318150000000000000402022D1E002205022702270600020503010000000000000000003318150000000000000402022D1E9EBB',
)

// Quick Wash: cloud course:"SPEEDWASH", spin:"SPIN_800", turboShot:"TURBOSHOT_ON", 15 minutes.
const QUICK_WASH = buf(
    'AA4E20EC002205003200320900020203010000000000000001003318150000000000000402022D1E002205000F000F0800020303010000000080000001003318150000000000000402022D1E8BBB',
)

// The downloaded program slot: cloud course:"DOWNLOAD" (holding Spin Only), loadLevel:5,
// soilWash:"NO_SOILWASH", temp:"NO_TEMP", rinse:"NO_RINSE".
const DOWNLOADED = buf(
    'AA4E20EC002205010A010A0100020102010000000000000000003318150000000000000400002D1E002205000C000C0E00000300000000000000000000003318150500000000000400002D1EAEBB',
)

// Drum Clean: cloud course:"TUB_CLEAN", temp:"TEMP_60", 2:09.
const DRUM_CLEAN = buf(
    'AA4E20EC002205002F002F0700020503010000000000400002003318150000000000000402022D1E002205020902090F00020304010000000000000002003318150000000000000400002D1EC2BB',
)

// Spin stepped to none: cloud spin:"NO_SPIN".
const NO_SPIN = buf(
    'AA4E20EC002205003300330700020502010000000000000002003318150000000000000402022D1E002205002400240700020002010000000000000002003318150000000000000402022D1ED2BB',
)

// Spin stepped to 1000: cloud spin:"SPIN_1000".
const SPIN_1000 = buf(
    'AA4E20EC002205002E002E0700020302010000000000000002003318150000000000000402022D1E002205002F002F0700020402010000000000000002003318150000000000000402022D1EC0BB',
)

// Rinse stepped to its last value: cloud rinse:"RINSE_RINSEPPHOLD".
const RINSE_PLUS_HOLD = buf(
    'AA4E20EC002205003300330700020502040000000400000003003318150000000000000402022D1E002205010101010700020502050000000400000003003318150000000000000402022D1E0CBB',
)

// Soil stepped to Soaking: cloud soilWash:"SOILWASH_SOAKING", 2:01.
const SOAKING = buf(
    'AA4E20EC002205011001100700040502050000000400000003003318150000000000000402022D1E002205020102010700050502050000000400000003003318150000000000000402022D1E48BB',
)

// One step on from Soaking: cloud soilWash:"NO_SOILWASH" and temp:"NO_TEMP" together.
const SOIL_NOT_SELECTED = buf(
    'AA4E20EC002205020102010700050502050000000400000003003318150000000000000402022D1E002205011801180700000500050000000400000003003318150500000000000402022D1E79BB',
)

// Steam on: cloud steam:"STEAM_ON" (with temp:"NO_TEMP"), rec[16] 0x04 -> 0x14.
const STEAM_ON = buf(
    'AA4E20EC002205003900390700010503050000000400000003003318150000000000000402022D1E002205020A020A0700010500050000001400000003003318150000000000000402022D1ED2BB',
)

// Child lock on: cloud childLock:"CHILDLOCK_ON" and nothing else, rec[16] 0x04 -> 0x0c.
const CHILD_LOCK_ON = buf(
    'AA4E20EC002205003900390700010503050000000400000004003318150000000000000402022D1E002205003900390700010503050000000C00000004003318150000000000000402022D1E8BBB',
)

// Crease Care on: cloud creaseCare:"CREASECARE_ON", rec[16] 0x04 -> 0x05, 1:10.
const CREASE_CARE_ON = buf(
    'AA4E20EC002205003900390700010503050000000400000004003318150000000000000402022D1E002205010A010A0700010503050000000500000004003318150000000000000402022D1E2EBB',
)

// Delay end at its maximum: cloud reserveTimeHour:19.
const DELAY_19H = buf(
    'AA4E20EC002205003900390700010503050010000400000004003318150000000000000402022D1E002205003900390700010503050013000400000004003318150000000000000402022D1EACBB',
)

// Remote start on: cloud remoteStart:"REMOTE_START_ON", rec[16] 0x40 -> 0x60.
const REMOTE_START_ON = buf(
    'AA4E20EC002205002F002F0700020503010000004000400004003318150000000000000402022D1E002205002F002F0700020503010000006000400004003318150000000000000402022D1E95BB',
)

// Rinse + Spin started: cloud state:"RINSING", preState:"INITIAL", remoteStart:"REMOTE_START_ON".
const STARTS_RINSING = buf(
    'AA4E20EC002205001300130D00000300010000000000000005003318150500000000000400022D1E00221E001300130D00000300010000002000000005053318150500000000000400022D1E21BB',
)

// Rinsing gives way to Spinning: cloud state:"SPINNING", preState:"RINSING", rinse:"NO_RINSE".
const SPINNING = buf(
    'AA4E20EC00221E000C00130D00000300010000002004000007053318150500000000000400022D1E002228000C00130D000003000000000020040000071E3318150500000000000400022D1E87BB',
)

// The cycle ends: cloud state:"END", course:"NOT_SELECTED", spin:"NO_SPIN", the times at 0,
// loadLevel:0, remoteStart:"REMOTE_START_OFF".
const ENDS = buf(
    'AA4E20EC002228000100130D000003000000000020040000201E3318150500000000000400022D1E00223C000000000000000000000000000004000020283318150000000000000402022D1EB2BB',
)

// The door lock has no cloud field on this model, so these two were checked against the door itself.
// Remote start switched off at the panel: about 5 s later the door was felt to unlock, and this frame
// arrived with rec[17] 0x04 -> 0x00 and nothing else moving.
const DOOR_UNLOCKS = buf(
    'AA4E20EC002205000000000000000000000000000004000000003318150000000000000402022D1E002205000000000000000000000000000000000000003318150000000000000402022D1EE9BB',
)

// Remote start switched back on: about 5 s later the door locked, rec[17] 0x00 -> 0x04.
const DOOR_LOCKS = buf(
    'AA4E20EC002205000000000000000000000000002000000000003318150000000000000402022D1E002205000000000000000000000000002004000000003318150000000000000402022D1EA9BB',
)

// Quick Wash started from the app with FreshCare on: cloud freshCare:"FRESHCARE_ON",
// turboShot:"TURBOSHOT_ON", state:"DETECTING". rec[16] 0x20 -> 0x22.
const FRESH_CARE_START = buf(
    'AA4E20EC002205000000000000000000000000002004000000003318150000000000000402022D1E002214000F000F0800020301010000002284000000053318150000000000000402022D1E96BB',
)

// A delayed Cotton start, after weighing: cloud state:"RESERVED", reserveTimeHour:3, loadLevel:1.
const DELAYED = buf(
    'AA4E20EC002214002F002F0700020503010003002044400000053318150000000000000402022D1E00220A002F002F0700020503010003002044400000143318150100000000000402022D1E41BB',
)

// Wool paused from the app: cloud state:"PAUSE", preState:"RUNNING".
const WOOL_PAUSED = buf(
    'AA4E20EC002217003100310C00020201010000002044000000143318150100000000000400002D1E002206003100310C00020201010000002004000000173318150100000000000400002D1E35BB',
)

// Smart Rinse downloaded from the app over Skin Care, whose settings it shares: rec[22] 0x35 -> 0x44 is
// the only byte to move, cloud downloadedCourse:"SMART_RINSE".
const SMART_RINSE_LOADED = buf(
    'AA4E20EC002205002100210E00020403010000002084400000003518050000000000000400002D1E002205002100210E00020403010000002084400000004418050000000000000400002D1E4ABB',
)

// Start pressed at the panel with the door open: cloud error:"ERROR_DE1" and state:"PAUSE", rec[8] 0 -> 17.
const DOOR_ERROR = buf(
    'AA4E20EC0022050000000000000000000000000000000000000039180E0000000000000402022D1E0022060000000000110000000000000000000000000539180E0000000000000402022D1E98BB',
)

// The door shut again: cloud error:"ERROR_NO", rec[8] 17 -> 0.
const DOOR_ERROR_CLEARS = buf(
    'AA4E20EC0022060000000000110000000000000000000000000539180E0000000000000402022D1E0022060000000000000000000000000000000000000539180E0000000000000402022D1E86BB',
)

// Spin Only, loaded in the Downloaded program and started from rethink, paused mid-spin: cloud
// state:"PAUSE", preState:"SPINNING". rec[7] 14, rec[22] 0x33, rec[24] 21.
const DOWNLOADED_PAUSED = buf(
    'AA4E20EC002228000B000C0E00000300000000002004000001053318150500000000000400002D1E002206000B000C0E00000300000000002004000001283318150500000000000400002D1EF0BB',
)

// Switched on at the panel out of standby: a record with rec[22..24] at 0, the cloud briefly reporting
// TCLCount:0 and downloadedCourse:"NOT_SELECTED", then a second later the real one, 24 and Shirt.
const BLANK_POWER_ON = buf(
    'AA4E20EC002205000000000000000000000000002024000002053A180E0001000000000402022D1E002205000000000000000000000000000000000000000000000000000000000402022D1EF1BB',
)
const REAL_POWER_ON = buf(
    'AA4E20EC002205000000000000000000000000000000000000000000000000000000000402022D1E002205000000000000000000000000000000000000003A180E0000000000000402022D1E0DBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('FAVTK23015', () => {
    test('a selected course decodes with all of its settings', () => {
        const p = feed([COTTON])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Cotton')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.temp, '40 °C')
        assert.equal(p.spin, '1100 rpm')
        assert.equal(p.rinse, 'Normal')
        assert.equal(p.steam, 'OFF')
        assert.equal(p.turbo_shot, 'OFF')
        assert.equal(p.remote_start, 'OFF')
    })

    test('the snapshot frame decodes like the current record of a change frame', () => {
        const p = feed([EB_POWER_OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.tub_clean_count, 24)
    })

    test('times are hours and minutes in separate bytes', () => {
        // 2:39 arrives as 02 27
        const eco = feed([COTTON_ECO])
        assert.equal(eco.remaining_time, 159)
        assert.equal(eco.initial_time, 159)
        assert.equal(feed([DRUM_CLEAN]).remaining_time, 129)
    })

    test('the course table covers the dial', () => {
        assert.equal(feed([COTTON_ECO]).course, 'Cotton Eco')
        assert.equal(feed([QUICK_WASH]).course, 'Quick Wash')
        assert.equal(feed([DOWNLOADED]).course, 'Downloaded program')
        assert.equal(feed([DRUM_CLEAN]).course, 'Drum Clean')
        assert.equal(feed([STARTS_RINSING]).course, 'Rinse + Spin')
    })

    test('soil, temperature, spin and rinse each read from their own byte', () => {
        assert.equal(feed([DRUM_CLEAN]).temp, '60 °C')
        assert.equal(feed([QUICK_WASH]).spin, '800 rpm')
        assert.equal(feed([NO_SPIN]).spin, 'No spin')
        assert.equal(feed([SPIN_1000]).spin, '1000 rpm')
        assert.equal(feed([RINSE_PLUS_HOLD]).rinse, 'Rinse+ + Hold')
        assert.equal(feed([SOAKING]).soil, 'Soaking')

        const none = feed([SOIL_NOT_SELECTED])
        assert.equal(none.soil, 'Not selected')
        assert.equal(none.temp, 'Not selected')
    })

    test('each option bit is told apart from its neighbours', () => {
        // rec[16] carries the rinse-hold bit 0x04 in all three of these, which must not leak into
        // any of the options
        const steam = feed([STEAM_ON])
        assert.equal(steam.steam, 'ON')
        assert.equal(steam.child_lock, 'OFF')
        assert.equal(steam.crease_care, 'OFF')

        const lock = feed([CHILD_LOCK_ON])
        assert.equal(lock.child_lock, 'ON')
        assert.equal(lock.steam, 'OFF')

        const crease = feed([CREASE_CARE_ON])
        assert.equal(crease.crease_care, 'ON')
        assert.equal(crease.child_lock, 'OFF')

        // and remote start sits beside the Favorite bit 0x40
        assert.equal(feed([REMOTE_START_ON]).remote_start, 'ON')
        assert.equal(feed([QUICK_WASH]).turbo_shot, 'ON')
    })

    test('the door lock is its own bit, apart from the remote start that triggers it', () => {
        const locked = feed([DOOR_LOCKS])
        assert.equal(locked.door_lock, 'ON')
        assert.equal(locked.remote_start, 'ON')

        const unlocked = feed([DOOR_UNLOCKS])
        assert.equal(unlocked.door_lock, 'OFF')
        assert.equal(unlocked.remote_start, 'OFF')

        // and it stays locked through a cycle, still set as it ends
        assert.equal(feed([SPINNING]).door_lock, 'ON')
        assert.equal(feed([ENDS]).door_lock, 'ON')
        // TurboShot shares rec[17] and must not read as a lock
        assert.equal(feed([QUICK_WASH]).door_lock, 'OFF')
    })

    test('delay end is in whole hours', () => {
        assert.equal(feed([DELAY_19H]).reserve_time, 19)
        assert.equal(feed([COTTON]).reserve_time, 0)
    })

    test('frames are acked exactly as the cloud acked them, status records not at all', () => {
        // each pair: what the washer sent, and the ack the bridged cloud answered it with
        const pairs: [string, string | undefined][] = [
            ['AA0B203E00130013016FBB', 'AA08F0003E04B1BB'],
            ['AA09207200C80058BB', 'AA08F00072044DBB'],
            [
                'AA2A20E203221E001300130D00000300010000002000000020053318150500000000000400022D1E1EBB',
                'AA08F000E204DDBB',
            ],
            [COTTON.toString('hex').toUpperCase(), undefined],
        ]
        for (const [rx, ack] of pairs) {
            const { thinq } = makeDevice()
            thinq.emit('data', buf(rx))
            const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
            assert.deepEqual(acks, ack ? [ack] : [], `ack for ${rx}`)
        }
    })

    test('a cycle runs through its states to the end', () => {
        const rinsing = feed([STARTS_RINSING])
        assert.equal(rinsing.status, 'Rinsing')
        assert.equal(rinsing.remote_start, 'ON') // switched on by Start, as this model does

        const spinning = feed([SPINNING])
        assert.equal(spinning.status, 'Spinning')
        assert.equal(spinning.remaining_time, 12)
        assert.equal(spinning.initial_time, 19)
        assert.equal(spinning.rinse, 'Not selected')

        const end = feed([ENDS])
        assert.equal(end.status, 'End')
        assert.equal(end.power, 'ON')
        assert.equal(end.course, 'None') // 0, nothing selected
        assert.equal(end.remaining_time, 0)
        assert.equal(end.remote_start, 'OFF')
    })

    test('start() sends the status request LG uses for this model', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        // byte for byte what the cloud sent the washer when it reconnected at 13:34:56
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa12f0ed1121010000001804131400005abb'],
        )
    })

    test('power and pause send the exact packets the app sent, which the washer obeyed', () => {
        // each byte for byte as captured from the LG app's traffic on 2026-11-14, and then sent from
        // rethink to the washer: Off -> Standby, Standby or Paused -> Off, and Rinsing -> Paused
        const cases: [string, string, string][] = [
            ['power', 'ON', 'aa08f02a010098bb'],
            ['power', 'OFF', 'aa09f0240101009cbb'],
            ['pause', '', 'aa09f02404010099bb'],
        ]
        for (const [prop, value, packet] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty(prop, value)
            assert.deepEqual(
                thinq.outbox.map((b) => b.toString('hex')),
                [packet],
                `${prop} ${value}`,
            )
        }
    })

    test('Start course sends what the app sent to start that course', () => {
        // each the app's own start command for the course at its defaults, as captured on 2026-11-14
        const cases: [string, number, string][] = [
            ['Rinse + Spin', 0, 'aa1bf0260d000300010000200020110000000000000000000068bb'],
            ['Wool', 0, 'aa1bf0260c020201010000200020080000000000000000000060bb'],
            ['Cotton', 3, 'aa1bf02607020503010300200020050000000000000000000060bb'],
            // never sent by the app: built by this handler, sent to the washer, and run as Easy Care
            // with a 3 h delay, cloud course:"EASY_CARE", reserveTimeHour:3
            ['Easy Care', 3, 'aa1bf0260a0205030103002000200c000000000000000000006abb'],
            // the app start for Drum Clean, captured after this table was written from the panel defaults
            // and the OpCourse list, which it matches byte for byte; cloud course:"TUB_CLEAN"
            ['Drum Clean', 0, 'aa1bf0260f0203040100002000200a000000000000000000006bbb'],
        ]
        for (const [course, delay, packet] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('set_delay_end', String(delay))
            dev.setProperty('start_course', course)
            assert.deepEqual(
                thinq.outbox.map((b) => b.toString('hex')),
                [packet],
                course,
            )
        }
    })

    test('Start course carries the default options of each course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start_course', 'Quick Wash')
        dev.setProperty('start_course', 'Baby Wear')
        const [quick, baby] = thinq.outbox
        // AA len | F0 26 | settings: TurboShot in byte 8, Steam with remote start in byte 7
        assert.equal(quick[2 + 2 + 8], 0x80)
        assert.equal(baby[2 + 2 + 7], 0x30)
    })

    test('Start course ignores unknown names, and the Downloaded program until it knows what is loaded', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start_course', 'Downloaded program')
        dev.setProperty('start_course', 'nonsense')
        assert.deepEqual(thinq.outbox, [])
    })

    test('the Downloaded program starts and resumes as the program loaded in it', () => {
        // Spin Only loaded: its settings and its base course, OpCourse position 21 (0x15), as in its download
        const start = makeDevice()
        start.thinq.emit('data', EB_POWER_OFF) // rec[22] = 0x33, Spin Only
        start.dev.setProperty('start_course', 'Downloaded program')
        assert.deepEqual(
            start.thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260e000300000000200020150000000000000000000014bb'],
        )

        // Paused during that spin, then resumed from rethink with this packet, which the washer obeyed:
        // cloud state:"PAUSE" -> "SPINNING". The base course comes from rec[24].
        const resume = makeDevice()
        resume.thinq.emit('data', DOWNLOADED_PAUSED)
        resume.dev.setProperty('resume', '')
        assert.deepEqual(
            resume.thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260e000300000000200000150000000000000000000074bb'],
        )
    })

    test('Set delayed end takes 0 or 3 to 19 hours, as on BDH_HI2103_EU, and ignores anything else', () => {
        const { ha, thinq, dev } = makeDevice()
        const set = (v: string) => {
            dev.setProperty('set_delay_end', v)
            return ha.devices[DEVICE_ID].properties.set_delay_end
        }
        assert.equal(set('5'), 5)
        assert.equal(set('2'), 5) // below the washer's 3-hour minimum: HA is put back on the held 5
        assert.equal(set('20'), 5) // above 19
        assert.equal(set('4.5'), 5) // whole hours only
        assert.equal(set('19'), 19)
        assert.equal(set('0'), 0)
        assert.deepEqual(thinq.outbox, []) // nothing is sent until a Start course

        // and the held value rides in the start
        dev.setProperty('set_delay_end', '7')
        dev.setProperty('start_course', 'Cotton')
        assert.equal(thinq.outbox[0][2 + 2 + 5], 7)
    })

    test('the held delay is published with each status, starting at 0', () => {
        assert.equal(feed([COTTON]).set_delay_end, 0)
    })

    test('Resume sends the paused cycle back as the app did', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('resume', '') // nothing known yet, nothing sent
        thinq.emit('data', WOOL_PAUSED)
        dev.setProperty('resume', '')
        // the app's resume for this same paused Wool cycle: the door lock in rec[17] is left out
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260c020201010000200000080000000000000000000040bb'],
        )
    })

    test('FreshCare and the Delayed state', () => {
        assert.equal(feed([FRESH_CARE_START]).fresh_care, 'ON')
        assert.equal(feed([COTTON]).fresh_care, 'OFF')
        const delayed = feed([DELAYED])
        assert.equal(delayed.status, 'Delayed')
        assert.equal(delayed.reserve_time, 3)
    })

    test('the downloaded program is read from its own byte', () => {
        assert.equal(feed([SMART_RINSE_LOADED]).downloaded_course, 'Smart Rinse')
        assert.equal(feed([COTTON]).downloaded_course, 'Spin Only') // what was loaded this morning
    })

    test('Download program sends the app download command for each, checksum and all', () => {
        // the full packets the app sent on 2026-11-14, each followed by the washer loading that program
        const cases: [string, string][] = [
            ['Cloth Care', 'aa1df02503150e020203010000200000084300000000000000000020bb'],
            ['Shirt', 'aa1df02503150e0302040100002000000e3a00000000000000000021bb'],
            ['Kids Wear', 'aa1df02503150e0303040100002000000e3900000000000000000021bb'],
            ['Rainy Day', 'aa1df02503150e0205030100002080000536000000000000000000bdbb'],
            ['School Uniform', 'aa1df02503150e020303010000208000053b000000000000000000bebb'],
            ['Skin Care', 'aa1df02503150e0204030100002080000535000000000000000000b3bb'],
            ['Smart Rinse', 'aa1df02503150e0204030100002080000544000000000000000000a0bb'],
            ['Spin Only', 'aa1df02503150e000300000000200000153300000000000000000038bb'],
            ['Sweat Stain', 'aa1df02503150e03030301000020000005370000000000000000003dbb'],
        ]
        for (const [program, packet] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('download', program)
            assert.deepEqual(
                thinq.outbox.map((b) => b.toString('hex')),
                [packet],
                program,
            )
        }
        const { thinq, dev } = makeDevice()
        dev.setProperty('download', 'nonsense')
        assert.deepEqual(thinq.outbox, [])
    })

    test('an error is reported, and cleared, from its own byte', () => {
        const error = feed([DOOR_ERROR])
        assert.equal(error.error, 'ON')
        assert.equal(error.error_message, 'Door error (dE1)')
        assert.equal(error.status, 'Paused')

        const cleared = feed([DOOR_ERROR, DOOR_ERROR_CLEARS])
        assert.equal(cleared.error, 'OFF')
        assert.equal(cleared.error_message, 'OK')
    })

    test('the blank record at power-on does not blip the counter or the downloaded program', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_POWER_OFF) // 24 washes, Spin Only loaded
        thinq.emit('data', BLANK_POWER_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.tub_clean_count, 24) // not 0
        assert.equal(p.downloaded_course, 'Spin Only') // not unknown
        assert.equal(p.power, 'OFF') // the blank record is dropped whole, the next one carries the state

        thinq.emit('data', REAL_POWER_ON)
        assert.equal(p.tub_clean_count, 24)
        assert.equal(p.downloaded_course, 'Shirt')
        assert.equal(p.status, 'Standby')
    })

    test('frames that are not status records publish nothing', () => {
        const junk = [
            'AA09207200C9005BBB', // 20 72, sent when remote start toggles
            'AA0B203E00130013016FBB', // 20 3E, near the end of a cycle
            'AA2A20E203221E001300130D00000300010000002000000020053318150500000000000400022D1E1EBB', // 20 E2
            'AA0820002A00A9BB', // the washer's ack
        ]
        for (const frame of junk) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(frame))
            assert.deepEqual(ha.devices[DEVICE_ID]?.properties ?? {}, {}, `frame ${frame} should publish nothing`)
        }
    })
})
