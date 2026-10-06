// The curated emoji for EmojiPicker (no npm dependency): a few hundred common emoji up to Unicode 13,
// so they render on current systems. One line per emoji: the glyph, its short English name, and
// after ";" extra search words. Every glyph is at most 16 UTF-16 units (the agent icon's limit).

export type EmojiCategoryId = "smileys" | "people" | "nature" | "food" | "activities" | "travel" | "objects" | "symbols";

const RAW: Array<{ id: EmojiCategoryId; label: string; icon: string; lines: string }> = [
  { id: "smileys", label: "Smileys", icon: "😀", lines: `
😀 grinning face; smile happy
😃 grinning face with big eyes; smile happy
😄 grinning face with smiling eyes; smile happy laugh
😁 beaming face; grin smile
😆 grinning squinting face; laugh
😅 grinning face with sweat; relief
🤣 rolling on the floor laughing; rofl lol
😂 face with tears of joy; laugh lol
🙂 slightly smiling face; smile
🙃 upside-down face; silly
😉 winking face; wink
😊 smiling face with smiling eyes; blush happy
😇 smiling face with halo; angel innocent
🥰 smiling face with hearts; love
😍 smiling face with heart-eyes; love
🤩 star-struck; wow excited
😘 face blowing a kiss; kiss love
😋 face savoring food; yum tasty
😛 face with tongue; playful
😜 winking face with tongue; playful silly
🤪 zany face; crazy silly
🤑 money-mouth face; rich money
🤗 hugging face; hug
🤭 face with hand over mouth; oops giggle
🤫 shushing face; quiet secret
🤔 thinking face; think hmm
🤐 zipper-mouth face; secret quiet
🤨 face with raised eyebrow; skeptical doubt
😐 neutral face; meh
😑 expressionless face; blank
😶 face without mouth; silent
😏 smirking face; smirk
😒 unamused face; meh
🙄 face with rolling eyes; eyeroll
😬 grimacing face; awkward
😌 relieved face; calm
😔 pensive face; sad
😪 sleepy face; tired
🤤 drooling face
😴 sleeping face; zzz sleep tired
😷 face with medical mask; sick mask
🤒 face with thermometer; sick ill
🤕 face with head-bandage; hurt
🤢 nauseated face; sick
🤮 face vomiting; sick
🥵 hot face; heat sweat
🥶 cold face; freezing
🥴 woozy face; dizzy
😵 dizzy face
🤯 exploding head; mind blown shocked
🤠 cowboy hat face; cowboy
🥳 partying face; party celebrate
😎 smiling face with sunglasses; cool
🤓 nerd face; geek glasses
🧐 face with monocle; inspect curious
😕 confused face; confused
😟 worried face; worry
🙁 slightly frowning face; sad
😮 face with open mouth; surprised wow
😯 hushed face; surprised
😲 astonished face; shocked
😳 flushed face; embarrassed
🥺 pleading face; please puppy eyes
😦 frowning face with open mouth
😨 fearful face; scared
😰 anxious face with sweat; nervous
😢 crying face; sad tear
😭 loudly crying face; sob sad
😱 face screaming in fear; scream scared
😖 confounded face
😣 persevering face
😞 disappointed face; sad
😓 downcast face with sweat
😩 weary face; tired
😫 tired face
🥱 yawning face; bored tired
😤 face with steam from nose; triumph angry
😡 pouting face; angry rage
😠 angry face; mad
🤬 face with symbols on mouth; swearing angry
😈 smiling face with horns; devil
💀 skull; dead
💩 pile of poo; poop
🤡 clown face; clown
👹 ogre; monster
👻 ghost; halloween
👽 alien; ufo
👾 alien monster; game invader
🤖 robot; bot ai machine
😺 grinning cat; cat smile
😸 grinning cat with smiling eyes; cat
😻 smiling cat with heart-eyes; cat love
🙈 see-no-evil monkey; monkey
🙉 hear-no-evil monkey; monkey
🙊 speak-no-evil monkey; monkey
` },
  { id: "people", label: "People", icon: "👋", lines: `
👋 waving hand; wave hello bye
🤚 raised back of hand
✋ raised hand; stop high five
🖖 vulcan salute; spock
👌 ok hand; okay perfect
🤌 pinched fingers
🤏 pinching hand; small
✌️ victory hand; peace
🤞 crossed fingers; luck
🤟 love-you gesture
🤘 sign of the horns; rock
🤙 call me hand
👈 backhand index pointing left; left
👉 backhand index pointing right; right
👆 backhand index pointing up; up
👇 backhand index pointing down; down
☝️ index pointing up; one
👍 thumbs up; like yes approve
👎 thumbs down; dislike no
✊ raised fist; fist
👊 oncoming fist; punch
👏 clapping hands; clap applause
🙌 raising hands; hooray celebrate
👐 open hands
🤲 palms up together
🤝 handshake; deal agreement
🙏 folded hands; please thanks pray
✍️ writing hand; write
💅 nail polish
💪 flexed biceps; strong muscle
🧠 brain; smart think mind
👀 eyes; look watch
👁️ eye; see
👂 ear; listen hear
👃 nose; smell
👄 mouth; lips
👶 baby
🧒 child; kid
👦 boy
👧 girl
🧑 person; adult
👨 man
👩 woman
🧓 older person; elder
👴 old man; grandpa
👵 old woman; grandma
👮 police officer; cop
🕵️ detective; spy investigate
💂 guard
👷 construction worker; builder
🤴 prince
👸 princess
🧑‍⚕️ health worker; doctor nurse
🧑‍🎓 student; graduate
🧑‍🏫 teacher; professor
🧑‍⚖️ judge; law
🧑‍🌾 farmer
🧑‍🍳 cook; chef
🧑‍🔧 mechanic; repair
🧑‍🔬 scientist; lab research
🧑‍💻 technologist; developer coder programmer computer
🧑‍💼 office worker; business
🧑‍🎨 artist; painter
🧑‍🚀 astronaut; space
🧑‍🚒 firefighter
🦸 superhero; hero
🦹 supervillain; villain
🧙 mage; wizard magic
🧚 fairy
🧛 vampire
🧜 merperson; mermaid
🧝 elf
🧞 genie; wish
🧟 zombie
🙋 person raising hand; question hi
🤷 person shrugging; shrug dunno
🤦 person facepalming; facepalm
🙇 person bowing; sorry
💁 person tipping hand; info
🧘 person in lotus position; yoga meditate
🏃 person running; run
🚶 person walking; walk
💃 woman dancing; dance
🕺 man dancing; dance
👯 people with bunny ears; party
👪 family
🗣️ speaking head; speak talk
👤 bust in silhouette; user profile
👥 busts in silhouette; users team group
` },
  { id: "nature", label: "Animals & nature", icon: "🐶", lines: `
🐶 dog face; dog puppy pet
🐱 cat face; cat kitten pet
🐭 mouse face; mouse
🐹 hamster
🐰 rabbit face; bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger face; tiger
🦁 lion
🐮 cow face; cow
🐷 pig face; pig
🐸 frog
🐵 monkey face; monkey
🐔 chicken
🐧 penguin
🐦 bird
🐤 baby chick; chick
🦆 duck
🦅 eagle
🦉 owl; wise night
🦇 bat
🐺 wolf
🐗 boar
🐴 horse face; horse
🦄 unicorn; magic
🐝 honeybee; bee busy
🐛 bug; caterpillar
🦋 butterfly
🐌 snail; slow
🐞 lady beetle; ladybug
🐜 ant
🕷️ spider
🐢 turtle; slow
🐍 snake
🦎 lizard
🦖 t-rex; dinosaur
🦕 sauropod; dinosaur
🐙 octopus
🦑 squid
🦀 crab
🐠 tropical fish; fish
🐟 fish
🐬 dolphin
🐳 spouting whale; whale
🦈 shark
🐊 crocodile
🐘 elephant; memory
🦒 giraffe
🦓 zebra
🦍 gorilla
🐪 camel
🐫 two-hump camel; camel
🦘 kangaroo
🐄 cow
🐑 ewe; sheep
🐐 goat
🦌 deer
🐕 dog
🐈 cat
🐓 rooster
🦜 parrot
🦢 swan
🦩 flamingo
🐿️ chipmunk; squirrel
🦔 hedgehog
🐾 paw prints; paw
🐉 dragon
🌵 cactus
🎄 christmas tree; xmas
🌲 evergreen tree; tree pine
🌳 deciduous tree; tree
🌴 palm tree; tropical beach
🌱 seedling; plant grow sprout
🌿 herb; leaf plant
☘️ shamrock; clover
🍀 four leaf clover; luck
🍁 maple leaf; autumn fall
🍂 fallen leaf; autumn
🍄 mushroom
🌷 tulip; flower
🌹 rose; flower love
🌺 hibiscus; flower
🌸 cherry blossom; flower spring
🌼 blossom; flower
🌻 sunflower; flower
🌞 sun with face; sunny
🌝 full moon face; moon
🌙 crescent moon; moon night
⭐ star
🌟 glowing star; star shine
✨ sparkles; magic shine new
⚡ high voltage; lightning zap fast
🔥 fire; flame hot lit
🌈 rainbow
☀️ sun; sunny weather
⛅ sun behind cloud; cloudy weather
☁️ cloud; weather
🌧️ cloud with rain; rain weather
⛈️ cloud with lightning and rain; storm
❄️ snowflake; snow cold winter
☃️ snowman; winter
🌊 water wave; wave ocean sea
💧 droplet; water drop
🌍 globe showing europe-africa; earth world globe
🌎 globe showing americas; earth world globe
🌏 globe showing asia-australia; earth world globe
` },
  { id: "food", label: "Food", icon: "🍎", lines: `
🍏 green apple; apple fruit
🍎 red apple; apple fruit
🍐 pear; fruit
🍊 tangerine; orange fruit
🍋 lemon; fruit
🍌 banana; fruit
🍉 watermelon; fruit
🍇 grapes; fruit
🍓 strawberry; fruit
🫐 blueberries; fruit
🍈 melon; fruit
🍒 cherries; fruit
🍑 peach; fruit
🥭 mango; fruit
🍍 pineapple; fruit
🥥 coconut
🥝 kiwi fruit; fruit
🍅 tomato
🍆 eggplant; aubergine
🥑 avocado
🥦 broccoli; vegetable
🥬 leafy green; vegetable salad
🥒 cucumber; vegetable
🌶️ hot pepper; chili spicy
🌽 ear of corn; corn
🥕 carrot; vegetable
🧄 garlic
🧅 onion
🥔 potato
🍞 bread
🥐 croissant
🥖 baguette bread; bread
🥨 pretzel
🧀 cheese wedge; cheese
🥚 egg
🍳 cooking; fried egg breakfast
🥞 pancakes; breakfast
🧇 waffle; breakfast
🥓 bacon
🍗 poultry leg; chicken
🍖 meat on bone; meat
🍔 hamburger; burger
🍟 french fries; fries
🍕 pizza
🌭 hot dog
🥪 sandwich
🌮 taco
🌯 burrito
🥗 green salad; salad
🍝 spaghetti; pasta
🍜 steaming bowl; ramen noodles
🍲 pot of food; stew
🍛 curry rice; curry
🍣 sushi
🍱 bento box; lunch
🥟 dumpling
🍤 fried shrimp; shrimp
🍙 rice ball
🍚 cooked rice; rice
🍦 soft ice cream; ice cream dessert
🍩 doughnut; donut dessert
🍪 cookie; dessert
🎂 birthday cake; cake birthday party
🍰 shortcake; cake dessert
🧁 cupcake; dessert
🍫 chocolate bar; chocolate
🍬 candy; sweet
🍭 lollipop; candy
🍯 honey pot; honey
🍿 popcorn; movie
🧂 salt
☕ hot beverage; coffee tea
🍵 teacup without handle; tea
🧃 beverage box; juice
🥤 cup with straw; soda drink
🧋 bubble tea; boba
🍺 beer mug; beer
🍻 clinking beer mugs; cheers beer
🥂 clinking glasses; cheers celebrate
🍷 wine glass; wine
🍸 cocktail glass; cocktail
🍴 fork and knife; eat restaurant
🥄 spoon
` },
  { id: "activities", label: "Activities", icon: "⚽", lines: `
⚽ soccer ball; football sport
🏀 basketball; sport
🏈 american football; football sport
⚾ baseball; sport
🎾 tennis; sport
🏐 volleyball; sport
🏉 rugby football; rugby sport
🎱 pool 8 ball; billiards
🏓 ping pong; table tennis
🏸 badminton
🏒 ice hockey; hockey
🏏 cricket game; cricket
⛳ flag in hole; golf
🏹 bow and arrow; archery
🎣 fishing pole; fishing
🥊 boxing glove; boxing
🥋 martial arts uniform; karate
⛸️ ice skate; skating
🎿 skis; ski
🏂 snowboarder; snowboard
🏋️ person lifting weights; gym weights
🚴 person biking; cycling bike
🏊 person swimming; swim
🏄 person surfing; surf
🧗 person climbing; climb
🏆 trophy; win award champion
🥇 1st place medal; gold first winner
🥈 2nd place medal; silver second
🥉 3rd place medal; bronze third
🏅 sports medal; medal
🎖️ military medal; medal
🎗️ reminder ribbon; ribbon
🎫 ticket
🎟️ admission tickets; ticket
🎪 circus tent; circus
🎭 performing arts; theater drama
🎨 artist palette; art paint design
🎬 clapper board; movie film
🎤 microphone; sing karaoke
🎧 headphone; music listen
🎼 musical score; music
🎹 musical keyboard; piano music
🥁 drum; music
🎷 saxophone; music jazz
🎺 trumpet; music
🎸 guitar; music rock
🎻 violin; music
🎲 game die; dice game
♟️ chess pawn; chess
🎯 direct hit; target goal bullseye
🎳 bowling
🎮 video game; game controller
🕹️ joystick; game
🧩 puzzle piece; puzzle
🧸 teddy bear; toy
🪁 kite
🎉 party popper; party celebrate tada
🎊 confetti ball; celebrate party
🎈 balloon; party birthday
🎁 wrapped gift; gift present birthday
🎀 ribbon; gift
🎃 jack-o-lantern; halloween pumpkin
🎆 fireworks; celebrate
🎇 sparkler; celebrate
🧨 firecracker
🎐 wind chime
📚 books; read study library
` },
  { id: "travel", label: "Travel", icon: "✈️", lines: `
🚗 automobile; car drive
🚕 taxi; cab
🚙 sport utility vehicle; suv car
🚌 bus
🚎 trolleybus
🏎️ racing car; race fast
🚓 police car; police
🚑 ambulance; emergency
🚒 fire engine; fire truck
🚐 minibus; van
🚚 delivery truck; truck shipping
🚛 articulated lorry; truck
🚜 tractor; farm
🛵 motor scooter; scooter
🏍️ motorcycle; motorbike
🚲 bicycle; bike
🛴 kick scooter
🚂 locomotive; train steam
🚆 train
🚇 metro; subway
🚊 tram
🚝 monorail
✈️ airplane; plane flight travel
🛫 airplane departure; takeoff
🛬 airplane arrival; landing
🚁 helicopter
🚀 rocket; launch space ship
🛸 flying saucer; ufo
🛰️ satellite; space
⛵ sailboat; boat sail
🚤 speedboat; boat
🛳️ passenger ship; cruise ship
⚓ anchor; ship
⛽ fuel pump; gas station
🚦 vertical traffic light; traffic
🚧 construction; work in progress wip
🗺️ world map; map
🧭 compass; direction navigate
🏔️ snow-capped mountain; mountain
⛰️ mountain
🌋 volcano
🏕️ camping; camp tent
🏖️ beach with umbrella; beach vacation
🏝️ desert island; island
🏜️ desert
🏞️ national park; park
🏟️ stadium
🏛️ classical building; museum
🏗️ building construction; construction
🏠 house; home
🏡 house with garden; home
🏢 office building; office work
🏣 japanese post office; post
🏥 hospital
🏦 bank
🏨 hotel
🏪 convenience store; shop
🏫 school
🏬 department store; shop
🏭 factory
🏰 castle
💒 wedding
🗼 tokyo tower; tower
🗽 statue of liberty
⛪ church
🕌 mosque
🛕 hindu temple; temple
🕍 synagogue
⛲ fountain
⛺ tent; camping
🌁 foggy
🌃 night with stars; night city
🏙️ cityscape; city
🌄 sunrise over mountains; sunrise
🌅 sunrise
🌆 cityscape at dusk; evening
🌇 sunset
🌉 bridge at night; bridge
🎡 ferris wheel; fair
🎢 roller coaster; fun
⏰ alarm clock; time alarm
⌛ hourglass done; time wait
⏳ hourglass not done; time wait loading
⌚ watch; time
🧳 luggage; travel suitcase
` },
  { id: "objects", label: "Objects", icon: "💡", lines: `
📱 mobile phone; phone smartphone
💻 laptop; computer
🖥️ desktop computer; computer
⌨️ keyboard; type
🖱️ computer mouse; mouse
🖨️ printer; print
💾 floppy disk; save
💿 optical disk; cd
📷 camera; photo
📸 camera with flash; photo
📹 video camera; video
🎥 movie camera; film video
📺 television; tv
📻 radio
🎙️ studio microphone; podcast mic
☎️ telephone; phone call
📞 telephone receiver; call phone
📟 pager
📠 fax machine; fax
🔋 battery; power
🔌 electric plug; plug power
💡 light bulb; idea tip
🔦 flashlight; torch
🕯️ candle
🧯 fire extinguisher
💸 money with wings; spend money
💵 dollar banknote; money cash
💰 money bag; money rich
💳 credit card; card payment
💎 gem stone; diamond jewel
⚖️ balance scale; law justice
🧰 toolbox; tools
🔧 wrench; tool fix settings
🔨 hammer; tool build
⚒️ hammer and pick; tools
🛠️ hammer and wrench; tools build fix
⛏️ pick; mine
🔩 nut and bolt; hardware
⚙️ gear; settings config cog
🧱 brick; wall
⛓️ chains; chain link
🧲 magnet; attract
🔫 water pistol; water gun
💣 bomb
🔪 kitchen knife; knife
🗡️ dagger; sword
⚔️ crossed swords; battle
🛡️ shield; security protect
🔮 crystal ball; magic predict fortune
🧿 nazar amulet
💈 barber pole
⚗️ alembic; chemistry
🔭 telescope; astronomy space
🔬 microscope; science lab research
🩺 stethoscope; doctor health
💊 pill; medicine health
💉 syringe; vaccine
🧬 dna; genetics biology
🦠 microbe; virus germ
🧪 test tube; science experiment lab
🌡️ thermometer; temperature
🧹 broom; clean
🧺 basket; laundry
🧻 roll of paper; toilet paper
🧼 soap; clean
🧽 sponge; clean
🛒 shopping cart; shop cart
🔑 key; password lock access
🗝️ old key; key
🚪 door
🪑 chair; seat
🛏️ bed; sleep
🛋️ couch and lamp; sofa
🖼️ framed picture; picture art
🛍️ shopping bags; shopping
✉️ envelope; email mail letter
📧 e-mail; email mail
📨 incoming envelope; inbox mail
📩 envelope with arrow; send mail
📤 outbox tray; outbox send
📥 inbox tray; inbox receive
📦 package; box parcel shipping
📫 closed mailbox with raised flag; mailbox
📮 postbox; mail
📝 memo; note write
📄 page facing up; document page file
📃 page with curl; document
📑 bookmark tabs
📊 bar chart; chart stats graph
📈 chart increasing; chart growth trend up
📉 chart decreasing; chart decline down
🗒️ spiral notepad; notepad notes
🗓️ spiral calendar; calendar date
📆 tear-off calendar; calendar date
📅 calendar; date schedule
📇 card index; contacts
🗃️ card file box; archive
🗄️ file cabinet; archive files
📋 clipboard; tasks list
📁 file folder; folder
📂 open file folder; folder
🗂️ card index dividers; organize
📰 newspaper; news
📓 notebook; notes journal
📔 notebook with decorative cover; journal
📒 ledger; notes
📕 closed book; book
📗 green book; book
📘 blue book; book
📙 orange book; book
📖 open book; book read
🔖 bookmark
🔗 link; url chain
📎 paperclip; attachment clip
🖇️ linked paperclips; attachment
📐 triangular ruler; ruler design
📏 straight ruler; ruler measure
📌 pushpin; pin
📍 round pushpin; pin location
✂️ scissors; cut
🖊️ pen; write
🖋️ fountain pen; pen write
✒️ black nib; pen
🖌️ paintbrush; paint art
🖍️ crayon; draw
✏️ pencil; edit write
🔍 magnifying glass tilted left; search find
🔎 magnifying glass tilted right; search find
🔏 locked with pen; privacy
🔐 locked with key; secure
🔒 locked; lock secure private
🔓 unlocked; unlock open
🔔 bell; notification alert
🔕 bell with slash; mute silent
📣 megaphone; announce
📢 loudspeaker; announcement
💬 speech balloon; chat message comment
💭 thought balloon; think
🗨️ left speech bubble; chat
🗯️ right anger bubble
🧾 receipt; invoice bill
🏷️ label; tag
🎓 graduation cap; education school graduate
👑 crown; king queen royal
🎩 top hat; hat magic
👓 glasses; read
🕶️ sunglasses; cool
🧢 billed cap; cap hat
👟 running shoe; sneaker
👜 handbag; bag
🎒 backpack; school bag
☂️ umbrella; rain
💼 briefcase; work business
🌂 closed umbrella
⏱️ stopwatch; timer time
⏲️ timer clock; timer
🕰️ mantelpiece clock; clock time
` },
  { id: "symbols", label: "Symbols", icon: "❤️", lines: `
❤️ red heart; love heart like
🧡 orange heart; love
💛 yellow heart; love
💚 green heart; love
💙 blue heart; love
💜 purple heart; love
🖤 black heart; love
🤍 white heart; love
🤎 brown heart; love
💔 broken heart; heartbreak sad
❣️ heart exclamation; love
💕 two hearts; love
💞 revolving hearts; love
💓 beating heart; love
💗 growing heart; love
💖 sparkling heart; love
💘 heart with arrow; love cupid
💝 heart with ribbon; love gift
💯 hundred points; 100 perfect score
💢 anger symbol; angry
💥 collision; boom explode
💫 dizzy; star
💦 sweat droplets; water
💨 dashing away; fast wind
🕳️ hole
💤 zzz; sleep
✅ check mark button; done yes ok complete
☑️ check box with check; done task
✔️ check mark; done yes ok
❌ cross mark; no wrong cancel delete
❎ cross mark button; no
➕ plus; add
➖ minus; remove subtract
➗ divide; division
✖️ multiply; times
❓ red question mark; question help
❔ white question mark; question
❗ red exclamation mark; exclamation important alert
❕ white exclamation mark; exclamation
‼️ double exclamation mark; exclamation
⁉️ exclamation question mark; interrobang
⚠️ warning; caution alert
⛔ no entry; stop forbidden
🚫 prohibited; forbidden no
🔞 no one under eighteen; adult
☢️ radioactive
☣️ biohazard
⬆️ up arrow; up
↗️ up-right arrow
➡️ right arrow; right next
↘️ down-right arrow
⬇️ down arrow; down
↙️ down-left arrow
⬅️ left arrow; left back
↖️ up-left arrow
↕️ up-down arrow
↔️ left-right arrow
🔄 counterclockwise arrows button; refresh sync reload repeat
🔁 repeat button; repeat loop
🔀 shuffle tracks button; shuffle random
▶️ play button; play start
⏸️ pause button; pause
⏹️ stop button; stop
⏺️ record button; record
⏭️ next track button; next skip
⏮️ last track button; previous
⏩ fast-forward button; fast forward
⏪ fast reverse button; rewind
🔼 upwards button; up
🔽 downwards button; down
♻️ recycling symbol; recycle green
⚜️ fleur-de-lis
🔱 trident emblem; trident
📛 name badge; badge
🔰 japanese symbol for beginner; beginner
⭕ hollow red circle; circle
🛑 stop sign; stop
🆕 new button; new
🆗 ok button; ok
🆒 cool button; cool
🆓 free button; free
🆙 up! button; up
🆘 sos button; sos help emergency
ℹ️ information; info help
🔤 input latin letters; abc alphabet
🔢 input numbers; numbers 123
#️⃣ keycap number sign; hash number
*️⃣ keycap asterisk; asterisk star
0️⃣ keycap 0; zero number
1️⃣ keycap 1; one number
2️⃣ keycap 2; two number
3️⃣ keycap 3; three number
🔟 keycap 10; ten number
💲 heavy dollar sign; dollar money
💱 currency exchange; money
©️ copyright
®️ registered
™️ trade mark; trademark
〰️ wavy dash
➰ curly loop
✳️ eight-spoked asterisk; asterisk
✴️ eight-pointed star
❇️ sparkle
🔴 red circle; red dot
🟠 orange circle; orange dot
🟡 yellow circle; yellow dot
🟢 green circle; green dot online
🔵 blue circle; blue dot
🟣 purple circle; purple dot
🟤 brown circle; brown dot
⚫ black circle; black dot
⚪ white circle; white dot
🟥 red square
🟧 orange square
🟨 yellow square
🟩 green square
🟦 blue square
🟪 purple square
⬛ black large square
⬜ white large square
🔶 large orange diamond; diamond
🔷 large blue diamond; diamond
🔺 red triangle pointed up; triangle
🔻 red triangle pointed down; triangle
💠 diamond with a dot
🔘 radio button
🏁 chequered flag; finish race flag
🚩 triangular flag; flag red
🏳️ white flag; flag surrender
🏴 black flag; flag
🏳️‍🌈 rainbow flag; pride flag
♈ aries; zodiac
♉ taurus; zodiac
♊ gemini; zodiac
♋ cancer; zodiac
♌ leo; zodiac
♍ virgo; zodiac
♎ libra; zodiac
♏ scorpio; zodiac
♐ sagittarius; zodiac
♑ capricorn; zodiac
♒ aquarius; zodiac
♓ pisces; zodiac
☮️ peace symbol; peace
☯️ yin yang; balance
🕉️ om
☸️ wheel of dharma
✡️ star of david
☪️ star and crescent
✝️ latin cross; cross
` }
];

export type Emoji = { glyph: string; name: string; keywords: string };
export type EmojiCategory = { id: EmojiCategoryId; label: string; icon: string; emoji: Emoji[] };

function parse(lines: string): Emoji[] {
  return lines.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const space = line.indexOf(" ");
    const glyph = line.slice(0, space);
    const [name = "", keywords = ""] = line.slice(space + 1).split(";").map((part) => part.trim());
    return { glyph, name, keywords };
  });
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = RAW.map(({ id, label, icon, lines }) => ({ id, label, icon, emoji: parse(lines) }));
