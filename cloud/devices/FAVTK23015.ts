import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { tombstone, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { RINSES } from './washer_common'
import { Enum } from '@/util/enum'

// LG LC0R2N2 front-load washer, matched on modelId "FAVTK23015" (thinq2 deviceType 201). The modelJSON
// calls it "VH Victor 2 5.0 20kg", a French-market model.
//
// It uses the short AABB framing (aa <len> 20 <type> ... <chk> bb) like the other EU washers, but
// its status record is 36 bytes with its own layout, so it cannot be aliased to them:
//   20 EB [record]                    a snapshot, sent in reply to the status request
//   20 EC [previous] [current]        a change notification
//
// Every offset below was live-verified: the washer was driven by hand at the panel while bridged to
// the LG cloud, and each byte change matched against the cloud's decoded washerDryer state at the
// same timestamp. Value codes are the modelJSON's own indices wherever it lists them; the course
// codes it does not list, so those were read off the wire by turning the dial.
//
// Other frames seen and not decoded: 20 72 (sent when remote start toggles), 20 3E (near the end of
// a cycle), 20 E2 (a snapshot of the cycle, sent at its end), 20 BD / 20 CD (long data dumps while
// running), 20 31 (device information, on connect).

const CLASS_BYTE = 0x20
const RECORD_LEN = 36

// LG's own status request for this model, taken verbatim from the cloud: it sends it each time the
// washer reconnects, and the washer answers with a 0xEB snapshot. 0xF0ED only reads.
const STATUS_REQUEST = 'F0ED112101000000180413140000'

const STATE_OFFSET = 2
// rec[3:5] and rec[5:7]: hours, minutes. The first counts down while running, the second holds the
// length the cycle was given.
const REMAIN_TIME_OFFSET = 3
const INITIAL_TIME_OFFSET = 5
const COURSE_OFFSET = 7
// rec[8]: the error, in the modelJSON's error indices. Starting at the panel with the door open set it
// to 17 as the cloud reported ERROR_DE1, and closing the door cleared it with the cloud's ERROR_NO.
const ERROR_OFFSET = 8
const SOIL_OFFSET = 9
const SPIN_OFFSET = 10
const TEMP_OFFSET = 11
const RINSE_OFFSET = 12
// rec[14]: delay end in hours, matching reserveTimeHour (3 to 19 as set from the panel, 0 when off)
const RESERVE_HOUR_OFFSET = 14
// rec[16]: option bits, each isolated against the cloud by toggling one control at a time.
// 0x04 follows the two rinse "+ Hold" settings, already covered by the rinse value; 0x40 appeared
// on loading the Favorite program, which the cloud has no field for. FreshCare has no panel button,
// it is set from the app, and the cloud's freshCare followed 0x02 on and off.
const OPT1_OFFSET = 16
const OPT1_CREASE_CARE = 0x01
const OPT1_FRESH_CARE = 0x02
const OPT1_CHILD_LOCK = 0x08
const OPT1_STEAM = 0x10
const OPT1_REMOTE_START = 0x20
// rec[17]: bit 0x80 is TurboShot. Bit 0x20 moved with the cloud's standby flag, but always together
// with rec[26], so it is not published.
// Bit 0x04 is the door lock. The cloud has no field for it on this model, so it was checked against
// the door itself: it sets about 5 s after remote start is switched on and clears about 5 s after it
// is switched off, each time the moment the lock was heard and felt to engage and release, and it
// stays set through a running cycle until the door is released after it.
const OPT2_OFFSET = 17
const OPT2_DOOR_LOCK = 0x04
const OPT2_TURBO_SHOT = 0x80
// rec[20] is a counter of the washer's own that ticks with no cloud field behind it, and rec[21] the
// state before the current one, the cloud's preState. Neither is published.
// rec[23]: the cloud's TCLCount, washes since the last Drum Clean. It held 24 throughout the capture,
// through Rinse + Spin, Spin Only and a 15-minute Quick Wash each run to End on an empty drum, so not
// every cycle counts; which ones do is not known yet. On F3L7CYK5W_US_WIFI the same counter goes up by
// one as each wash completes. The washer also sends it
// on its own at power-on, as 20 D8 <count>, which the record already covers.
const TUB_CLEAN_COUNT_OFFSET = 23
// rec[25] matches the cloud's loadLevel, but was only ever seen at 0 and at 5 (on courses that don't
// weigh the load, outside the modelJSON's 0-4), so it is not published until a weighed load is seen.

const STATE_POWEROFF = 0

// Commands, each taken from the app's own traffic and then sent from rethink to confirm the washer
// does the same: these are the bytes other EU washers here use too.
// Power on wakes the washer into Standby with remote start switched on (the door locks with it). It
// only works for a short while after the washer was switched off: about 105 s later its Wi-Fi module
// reconnects, and from then on the washer acks the command but stays off, until switched on at the
// panel. HA then simply keeps showing it off.
const CMD_POWER_ON = 'F02A0100'
const CMD_POWER_OFF = 'F024010100' // from Standby, a running cycle or a pause
const CMD_PAUSE = 'F024040100'
// Not exposed: the generic start, F0 24 05 01 00. On a washer woken remotely it starts the default
// course (Cotton) whatever the dial says, and it is refused while paused. The app starts and resumes
// with an F0 26 command carrying the course and its settings instead, built by startCommand() below.
//
// F0 26, as decoded from five app starts and two resumes, each matched against what the washer then
// reported:
//   [0] course  [1] soil  [2] spin  [3] temp  [4] rinse      the status record's codes
//   [5] delay end in hours (0 = now)  [6] 00
//   [7] rec[16]'s option bits, remote start 0x20 included  [8] rec[17]'s TurboShot bit
//   [9] 0x20 to start, 0x00 to resume from a pause
//   [10] the course's 1-based position in the modelJSON's OpCourse list (OP_INDEX below)
//   [11..20] 00
// Like the app, it is only obeyed with remote start on.
const START_LEN = 21
const START_NEW = 0x20
const START_RESUME = 0x00
// The modelJSON gives 3 to 19 hours for the delay; the panel steps through the same range.
const DELAY_MIN_HOURS = 3
const DELAY_MAX_HOURS = 19

// The modelJSON's state indices. Off, Standby, Paused, Rinsing, Spinning and End were each seen live
// against the cloud's state field; the rest of the table is LG's mapping for the same field.
// Labels follow the other washers.
const STATUS = Enum.of({
    Off: 0,
    Standby: [5, 83], // the second one is FROZEN_PREVENT_INITIAL
    Paused: [6, 85], // + FROZEN_PREVENT_PAUSE
    Error: 7, // ERROR_AUTO_OFF
    Delayed: 10,
    Detecting: 20,
    'Add drain': 21,
    'Detergent amount': 22,
    Washing: [23, 84], // + FROZEN_PREVENT_RUNNING
    'Pre-wash': 24,
    Rinsing: 30,
    'Rinse hold': 31,
    Spinning: 40,
    Drying: 50,
    End: 60,
    Refreshing: 61,
    'Audible diagnosis': 101,
})

// All 15 positions of the dial, each read off the wire and named by the cloud at the same moment
// (cloud identifiers in the trailing comments). 0 is what the washer reports with nothing selected,
// at the end of a cycle.
const COURSE = Enum.of({
    Sportswear: 1, // UTILITY
    'Allergy Care': 2, // ALLERGYCARE
    'Speed Boil': 3, // SPEEDBOIL
    'Baby Wear': 4, // BABYWEAR
    'Heavy Duty': 5, // HEAVYDUTY
    'Cotton Eco': 6, // COTTON_ECO
    Cotton: 7, // COTTON
    'Quick Wash': 8, // SPEEDWASH
    Silent: 9, // SILENT
    'Easy Care': 10, // EASY_CARE
    Duvet: 11, // DUVET
    Wool: 12, // LINGERIE_WOOL
    'Rinse + Spin': 13, // RINSE_SPIN
    'Downloaded program': 14, // DOWNLOAD, whichever program the app last downloaded
    'Drum Clean': 15, // TUB_CLEAN
})

// What a remote start sends for each course, keyed by course code:
//   op       the course's position in the modelJSON's OpCourse list, F0 26 byte [10]. Seen on the
//            wire for Cotton (5), Quick Wash (4), Wool (8) and Rinse + Spin (17), the rest read
//            off the same list; Easy Care (12), which the app never sent, was then started from
//            rethink and the washer ran it, and the app's later Drum Clean start (10) matched this
//            table byte for byte.
//   defaults soil, spin, temp, rinse and the two option bytes the washer itself set when the dial
//            was turned onto the course, so a start matches what pressing Start at the panel would
//            run. They match what the app sent for each course it started.
// The Downloaded program has no OpCourse position of its own: it is started with the settings and base
// course of whichever program is loaded in it, see downloadedStart().
type StartCourse = { op: number; soil: number; spin: number; temp: number; rinse: number; opt1: number; opt2: number }
const START_COURSES: Record<number, StartCourse> = {
    1: { op: 3, soil: 2, spin: 1, temp: 2, rinse: 1, opt1: 0, opt2: 0 },
    2: { op: 2, soil: 2, spin: 3, temp: 0, rinse: 1, opt1: OPT1_STEAM, opt2: 0 },
    3: { op: 13, soil: 2, spin: 3, temp: 5, rinse: 1, opt1: 0, opt2: 0 },
    4: { op: 11, soil: 2, spin: 3, temp: 0, rinse: 1, opt1: OPT1_STEAM, opt2: 0 },
    5: { op: 14, soil: 3, spin: 3, temp: 4, rinse: 1, opt1: 0, opt2: 0 },
    6: { op: 6, soil: 2, spin: 5, temp: 3, rinse: 1, opt1: 0, opt2: 0 },
    7: { op: 5, soil: 2, spin: 5, temp: 3, rinse: 1, opt1: 0, opt2: 0 },
    8: { op: 4, soil: 2, spin: 3, temp: 3, rinse: 1, opt1: 0, opt2: OPT2_TURBO_SHOT },
    9: { op: 7, soil: 2, spin: 2, temp: 3, rinse: 1, opt1: 0, opt2: 0 },
    10: { op: 12, soil: 2, spin: 5, temp: 3, rinse: 1, opt1: 0, opt2: 0 },
    11: { op: 9, soil: 2, spin: 3, temp: 1, rinse: 1, opt1: 0, opt2: 0 },
    12: { op: 8, soil: 2, spin: 2, temp: 1, rinse: 1, opt1: 0, opt2: 0 },
    13: { op: 17, soil: 0, spin: 3, temp: 0, rinse: 1, opt1: 0, opt2: 0 },
    15: { op: 10, soil: 2, spin: 3, temp: 4, rinse: 1, opt1: 0, opt2: 0 },
}
const DOWNLOADED_COURSE = 14
const START_COURSE_OPTIONS = [...Object.keys(START_COURSES).map(Number), DOWNLOADED_COURSE]
    .sort((a, b) => a - b)
    .map((code) => COURSE.map(code) as string)

// The programs the app can download into the Downloaded program slot, by the id the washer reports for
// the loaded one in rec[22]. Each was downloaded from the app while the cloud named it, and rec[22] moved
// to its id: for Smart Rinse, whose settings match Skin Care's, rec[22] was the only byte to move.
// rec[24] holds the loaded program's base course as its OpCourse position, which isn't published.
const DOWNLOADED = Enum.of({
    'Skin Care': 0x35, // SKIN_CARE
    'Rainy Day': 0x36, // RAINY_DAY
    'Sweat Stain': 0x37, // SWEAT_STAIN
    'Kids Wear': 0x39, // KIDS_WEAR
    Shirt: 0x3a, // SHIRT
    'School Uniform': 0x3b, // SCHOOL_UNIFORM
    'Spin Only': 0x33, // SPIN_ONLY
    'Cloth Care': 0x43, // CLOTH_CARE
    'Smart Rinse': 0x44, // SMART_RINSE
})

// The app's download command for each, verbatim: F0 25, 03, the 0x15 (21) bytes that follow, which are laid
// out like F0 26 (course 14, the program's soil/spin/temp/rinse, delay, 00, options, TurboShot, 00, its
// base course's OpCourse position) with the program's id in byte [11]. The washer acks it, selects the slot
// and reports the new program in rec[22].
const DOWNLOAD_COMMANDS: Record<string, string> = {
    'Skin Care': 'F02503150E0204030100002080000535000000000000000000',
    'Rainy Day': 'F02503150E0205030100002080000536000000000000000000',
    'Sweat Stain': 'F02503150E0303030100002000000537000000000000000000',
    'Kids Wear': 'F02503150E0303040100002000000E39000000000000000000',
    Shirt: 'F02503150E0302040100002000000E3A000000000000000000',
    'School Uniform': 'F02503150E020303010000208000053B000000000000000000',
    'Spin Only': 'F02503150E0003000000002000001533000000000000000000',
    'Cloth Care': 'F02503150E0202030100002000000843000000000000000000',
    'Smart Rinse': 'F02503150E0204030100002080000544000000000000000000',
}
const DOWNLOADED_OFFSET = 22
// rec[24]: the loaded program's base course as its OpCourse position, matching the download command's
// byte for it each time (Wool 8 for Cloth Care, Heavy Duty 14 for Shirt, ...). Resuming the Downloaded
// program needs it.
const DOWNLOADED_BASE_OFFSET = 24

// Starting the Downloaded program: F0 26 with the loaded program's own settings and base course, as its
// download command carries them. Sent from rethink for Spin Only, the washer ran it as the Downloaded
// program at 800 rpm.
function downloadedStart(loadedId: number): { settings: number[]; op: number } | undefined {
    const name = DOWNLOADED.map(loadedId)
    const command = name && DOWNLOAD_COMMANDS[name]
    if (!command) return undefined
    // after F0 25 03 15: course, soil, spin, temp, rinse, delay, 00, opt1, opt2, 00, base course, id
    const data = Buffer.from(command, 'hex').subarray(4)
    return { settings: [...data.subarray(0, 9)], op: data[10] }
}

// The modelJSON's error table, which numbers the codes differently from washer_common's ERRORS. Only dE1
// was seen live; the rest are named from the modelJSON's own descriptions of each, in the wording
// washer_common uses for the same faults.
const ERRORS = Enum.of({
    OK: 0,
    'Door open error (dE2)': 1,
    'Water supply error (IE)': 2,
    'Water drain error (OE)': 3,
    'Out of balance error (UE)': 4,
    'Overfill error (FE)': 5,
    'Water level sensor error (PE)': 6,
    'Temperature sensor error (tE)': 7,
    'Locked motor error (LE)': 8,
    'Unknown error (CE)': 9,
    'Service call error (dHE)': 10,
    'Power fail error (PF)': 11,
    'Freeze error (FF)': 12,
    'Unknown error (dCE)': 13,
    'Vibration sensor error (VS)': 14,
    'EEPROM error (EE)': 15,
    'Unknown error (PS)': 16,
    'Door error (dE1)': 17, // the modelJSON's "door open/close error"
    'Lid open error (LOE)': 18,
    'Door sensor error (dE4)': 19,
})

// 0 is "not selected", what the courses without a soil level or temperature report
const SOIL = Enum.of({
    'Not selected': 0,
    Light: 1,
    Normal: 2,
    Heavy: 3,
    'Pre-wash': 4,
    Soaking: 5,
})

const TEMP = Enum.of({
    'Not selected': 0,
    Cold: 1,
    '20 °C': 2,
    '40 °C': 3,
    '60 °C': 4,
    '95 °C': 5,
})

const SPIN = Enum.of({
    'No spin': 0,
    '400 rpm': 1,
    '600 rpm': 2,
    '800 rpm': 3,
    '1000 rpm': 4,
    '1100 rpm': 5,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // The acks match what the cloud sent this washer while bridged: f0 00 <type> 04 for the 20 3E,
        // 20 72 and 20 E2 frames, and nothing for the 20 EB / 20 EC status records.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-circle-outline',
                    },
                    start_course: {
                        platform: 'select',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        options: START_COURSE_OPTIONS,
                        name: 'Start course',
                        icon: 'mdi:play-box-outline',
                        // No state_topic: picking a course starts it at its defaults, with the Delay start
                        // below folded in. Needs remote start on, as in the app.
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded program',
                        icon: 'mdi:download-box-outline',
                        device_class: 'enum',
                        options: DOWNLOADED.options,
                    },
                    download: {
                        platform: 'select',
                        unique_id: '$deviceid-download',
                        command_topic: '$this/download/set',
                        options: DOWNLOADED.options,
                        name: 'Download program',
                        icon: 'mdi:download',
                        // No state_topic: picking one loads it into the Downloaded program slot, without
                        // starting anything. The sensor above then shows it loaded.
                    },
                    // As on BDH_HI2103_EU: fixed 0..19 h limits, 0 for no delay. Hours folded into the next
                    // Start course, not sent on its own.
                    set_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_end',
                        state_topic: '$this/set_delay_end',
                        command_topic: '$this/set_delay_end/set',
                        name: 'Set delayed end',
                        icon: 'mdi:timer-sand',
                        min: 0,
                        max: DELAY_MAX_HOURS,
                        step: 1,
                        unit_of_measurement: 'h',
                    },
                    delay: tombstone('number'), // the first version's name for set_delay_end
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSE.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Reserve time',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                        device_class: 'enum',
                        options: RINSES.options,
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    turbo_shot: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_shot',
                        state_topic: '$this/turbo_shot',
                        name: 'TurboShot',
                        icon: 'mdi:rocket-launch',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'FreshCare',
                        icon: 'mdi:air-filter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock', that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // No state_class: the counter resets at each Drum Clean, so total_increasing
                        // would accumulate across the reset.
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // The washer only volunteers a frame when something changes, so ask once per connect, as LG's
    // cloud does, or the entities stay unknown after a restart.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // Hours of delay for the next Start course, set by the set_delay_end entity. In memory only.
    private delayHours = 0
    // The last status record, which Resume rebuilds the paused cycle from
    private lastRecord: Buffer | undefined

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') this.send(Buffer.from(CMD_POWER_ON, 'hex'))
            else if (mqttValue === 'OFF') this.send(Buffer.from(CMD_POWER_OFF, 'hex'))
        } else if (prop === 'pause') {
            this.send(Buffer.from(CMD_PAUSE, 'hex'))
        } else if (prop === 'start_course') {
            const code = COURSE.unmap(mqttValue)
            if (code === DOWNLOADED_COURSE) {
                // whatever is loaded, which the washer reports even while off
                const start = this.lastRecord && downloadedStart(this.lastRecord[DOWNLOADED_OFFSET])
                if (!start) return
                const settings = [...start.settings]
                settings[5] = this.delayHours
                settings[7] |= OPT1_REMOTE_START
                this.send(startCommand(settings, START_NEW, start.op))
                return
            }
            const course = code === undefined ? undefined : START_COURSES[code]
            if (code === undefined || !course) return
            const { op, soil, spin, temp, rinse, opt1, opt2 } = course
            const settings = [code, soil, spin, temp, rinse, this.delayHours, 0, opt1 | OPT1_REMOTE_START, opt2]
            this.send(startCommand(settings, START_NEW, op))
        } else if (prop === 'resume') {
            // The app resumes by sending the paused cycle back as it stands, with the resume flag
            const rec = this.lastRecord
            if (!rec) return
            // the Downloaded program resumes on the base course of what is loaded in it
            const op =
                rec[COURSE_OFFSET] === DOWNLOADED_COURSE
                    ? rec[DOWNLOADED_BASE_OFFSET]
                    : START_COURSES[rec[COURSE_OFFSET]]?.op
            if (!op) return
            const settings = [
                rec[COURSE_OFFSET],
                rec[SOIL_OFFSET],
                rec[SPIN_OFFSET],
                rec[TEMP_OFFSET],
                rec[RINSE_OFFSET],
                rec[RESERVE_HOUR_OFFSET],
                0,
                rec[OPT1_OFFSET],
                rec[OPT2_OFFSET] & OPT2_TURBO_SHOT, // without the door lock and the other state bits
            ]
            this.send(startCommand(settings, START_RESUME, op))
        } else if (prop === 'download') {
            const command = DOWNLOAD_COMMANDS[mqttValue]
            if (command) this.send(Buffer.from(command, 'hex'))
        } else if (prop === 'set_delay_end') {
            // As on BDH_HI2103_EU: 0 is "no delay", anything else must be within the modelJSON range.
            // An invalid value is ignored, and republishing the current one puts HA back on it.
            const hours = Number(mqttValue)
            const valid =
                Number.isInteger(hours) && (hours === 0 || (hours >= DELAY_MIN_HOURS && hours <= DELAY_MAX_HOURS))
            if (valid) this.delayHours = hours
            this.HA.publishProperty(this.id, 'set_delay_end', this.delayHours)
        }
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, CLASS_BYTE, RECORD_LEN, this.processStatus)
    }

    private processStatus(rec: Buffer) {
        // Powered on at the panel out of standby, the washer once sent a record with rec[22..24] all 0 for
        // a second before the real one, which would blip the drum clean counter to 0 and the downloaded
        // program to unknown. A real record always has a program loaded in rec[22], even right after a
        // Drum Clean resets rec[23], so the three at 0 together only mark that blank one. F3P2CYUBE__
        // drops its own blank power-on record the same way.
        if (rec[DOWNLOADED_OFFSET] === 0 && rec[TUB_CLEAN_COUNT_OFFSET] === 0 && rec[DOWNLOADED_BASE_OFFSET] === 0)
            return
        this.lastRecord = Buffer.from(rec)
        const state = rec[STATE_OFFSET]
        const opt1 = rec[OPT1_OFFSET]

        this.publishProperty('power', state === STATE_POWEROFF ? 'OFF' : 'ON')
        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // the message before the error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('remaining_time', rec[REMAIN_TIME_OFFSET] * 60 + rec[REMAIN_TIME_OFFSET + 1])
        this.publishProperty('initial_time', rec[INITIAL_TIME_OFFSET] * 60 + rec[INITIAL_TIME_OFFSET + 1])
        this.publishProperty('reserve_time', rec[RESERVE_HOUR_OFFSET])
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('rinse', RINSES.map(rec[RINSE_OFFSET]))
        this.publishProperty('steam', opt1 & OPT1_STEAM ? 'ON' : 'OFF')
        this.publishProperty('crease_care', opt1 & OPT1_CREASE_CARE ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', opt1 & OPT1_FRESH_CARE ? 'ON' : 'OFF')
        this.publishProperty('child_lock', opt1 & OPT1_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('remote_start', opt1 & OPT1_REMOTE_START ? 'ON' : 'OFF')
        this.publishProperty('turbo_shot', rec[OPT2_OFFSET] & OPT2_TURBO_SHOT ? 'ON' : 'OFF')
        this.publishProperty('door_lock', rec[OPT2_OFFSET] & OPT2_DOOR_LOCK ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('downloaded_course', DOWNLOADED.map(rec[DOWNLOADED_OFFSET]))
        this.publishProperty('set_delay_end', this.delayHours) // so HA starts at 0, not unknown
    }
}

// F0 26: the settings bytes [0..8] as laid out above, then the start/resume flag and the OpCourse
// position, padded to the 21 bytes the app always sends.
function startCommand(settings: number[], flag: number, op: number): Buffer {
    const body = Buffer.alloc(START_LEN)
    settings.forEach((value, i) => (body[i] = value))
    body[9] = flag
    body[10] = op
    return Buffer.concat([Buffer.from([0xf0, 0x26]), body])
}
