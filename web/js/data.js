/* ==========================================================================
   Sunshine个人工作站 — 模拟数据层 (Mock Data)
   ========================================================================== */

// 学科定义（配色 / 图标）
const SUBJECTS = {
  chinese: { name: '语文', icon: 'i-book-open', color: '#DE6B7C', soft: '#FCEAEE' },
  math:    { name: '数学', icon: 'i-chart',     color: '#4C9BD4', soft: '#E8F3FB' },
  english: { name: '英语', icon: 'i-message',   color: '#8B7FD4', soft: '#EFECFB' },
  science: { name: '科学', icon: 'i-flask',     color: '#3FAE86', soft: '#E4F6EE' },
  art:     { name: '美术', icon: 'i-palette',   color: '#E9A62E', soft: '#FDF2DC' },
  music:   { name: '音乐', icon: 'i-music',     color: '#35A2A0', soft: '#E2F5F4' },
  pe:      { name: '体育', icon: 'i-heart',     color: '#F2653A', soft: '#FFF0E8' },
  moral:   { name: '道德与法治', icon: 'i-shield', color: '#6E9E4E', soft: '#EFF5E6' },
};

const GRADES = [1, 2, 3, 4, 5, 6];
const GRADE_CN = ['一', '二', '三', '四', '五', '六'];
const gradeLabel = (g) => `${GRADE_CN[g - 1]}年级`;

// 学习资料（覆盖 1-6 年级主要学科）
const MATERIALS = [
  { id:'m01', title:'拼音王国大冒险', subject:'chinese', grade:1, type:'互动课', minutes:15, rating:4.9, desc:'跟着小动物一起认识声母韵母，轻松掌握拼音拼读。', points:['单韵母 a o e i u ü','声母 b p m f','整体认读音节'], chapters:['认识单韵母','声母初体验','拼读小能手','整体认读音节'] },
  { id:'m02', title:'10以内的加减法', subject:'math', grade:1, type:'练习册', minutes:20, rating:4.8, desc:'用数数和分合的方法，掌握 10 以内加减法运算。', points:['数的分解与组成','加法初步','减法初步'], chapters:['认识数字1-10','分与合','加法乐园','减法小能手'] },
  { id:'m03', title:'Hello! 我的家人', subject:'english', grade:1, type:'情景对话', minutes:12, rating:4.7, desc:'通过家庭场景学习基础英语问候与家庭成员称呼。', points:['Hello / Hi 问候','father mother 等词汇'], chapters:['打招呼','认识家人','我会介绍'] },
  { id:'m04', title:'秋天的树叶画', subject:'art', grade:1, type:'手工课', minutes:25, rating:4.9, desc:'收集落叶，发挥想象，创作独一无二的树叶贴画。', points:['观察树叶形状','色彩搭配','拼贴技巧'], chapters:['采集与观察','构思创作','作品展示'] },
  { id:'m05', title:'认识常见的动物', subject:'science', grade:2, type:'科普视频', minutes:18, rating:4.8, desc:'认识身边常见动物的特征与生活习性。', points:['哺乳动物','鸟类与昆虫','动物栖息地'], chapters:['动物朋友','它们住在哪里','保护动物'] },
  { id:'m06', title:'乘法口诀轻松记', subject:'math', grade:2, type:'互动课', minutes:22, rating:4.9, desc:'朗朗上口的口诀配合游戏，快速记住九九乘法表。', points:['2-9 的乘法口诀','口诀应用'], chapters:['2和3的口诀','4到6的口诀','7到9的口诀','口诀挑战'] },
  { id:'m07', title:'美德小故事会', subject:'moral', grade:2, type:'故事', minutes:14, rating:4.6, desc:'通过绘本故事学习诚实、友善、守规则等美德。', points:['诚实做人','友好相处','遵守规则'], chapters:['诚实的孩子','分享的快乐','我是小公民'] },
  { id:'m08', title:'节奏与律动启蒙', subject:'music', grade:3, type:'音乐课', minutes:20, rating:4.7, desc:'用身体律动感受节拍，认识基本节奏型。', points:['节拍感知','四分音符','简单打击乐'], chapters:['感受节拍','节奏模仿','合奏体验'] },
  { id:'m09', title:'观察日记写作法', subject:'chinese', grade:3, type:'写作指导', minutes:24, rating:4.8, desc:'学会用五感观察事物，写出生动的观察日记。', points:['五感观察法','按顺序描写','加入想象'], chapters:['什么是观察日记','五感练一练','写出好句子'] },
  { id:'m10', title:'周长与面积初识', subject:'math', grade:3, type:'互动课', minutes:26, rating:4.7, desc:'通过格子图理解周长和面积的概念。', points:['周长的含义','面积的含义','长方形正方形'], chapters:['认识周长','认识面积','动手量一量'] },
  { id:'m11', title:'My School Day', subject:'english', grade:3, type:'情景对话', minutes:16, rating:4.6, desc:'学习描述一天的校园生活与课程安排。', points:['时间表达','课程词汇','日常对话'], chapters:['我的一天','喜欢的课程','和朋友聊天'] },
  { id:'m12', title:'植物的一生', subject:'science', grade:4, type:'科普视频', minutes:28, rating:4.9, desc:'观察种子发芽到开花结果，了解植物生命周期。', points:['种子结构','发芽条件','生命周期'], chapters:['种子的秘密','发芽啦','开花结果'] },
  { id:'m13', title:'分数的初步认识', subject:'math', grade:4, type:'练习册', minutes:25, rating:4.8, desc:'借助图形理解分数的意义，会比较简单分数大小。', points:['几分之一','几分之几','分数比较'], chapters:['认识几分之一','认识几分之几','分数比大小'] },
  { id:'m14', title:'我的家乡', subject:'chinese', grade:4, type:'写作指导', minutes:22, rating:4.7, desc:'围绕家乡写一篇情景交融的介绍文章。', points:['选取典型景物','按顺序描写','表达情感'], chapters:['家乡的景','家乡的味','家乡的人'] },
  { id:'m15', title:'小小运动员', subject:'pe', grade:5, type:'运动课', minutes:30, rating:4.8, desc:'学习正确的跑步姿势与跳绳技巧，科学锻炼。', points:['跑步呼吸','跳绳节奏','热身放松'], chapters:['热身运动','跑步技巧','跳绳训练'] },
  { id:'m16', title:'地球与宇宙', subject:'science', grade:5, type:'科普视频', minutes:32, rating:4.9, desc:'认识太阳系、地球运动与昼夜四季的成因。', points:['太阳系','地球自转','四季变化'], chapters:['我们的太阳系','昼夜交替','四季轮回'] },
  { id:'m17', title:'简易方程入门', subject:'math', grade:5, type:'互动课', minutes:28, rating:4.7, desc:'从天平原理出发，理解方程与解方程。', points:['等式性质','未知数','解方程'], chapters:['天平与等式','认识方程','解简单方程'] },
  { id:'m18', title:'英语小剧场', subject:'english', grade:5, type:'情景对话', minutes:20, rating:4.8, desc:'通过分角色表演，提升英语口语表达自信。', points:['日常用语','角色扮演','语音语调'], chapters:['剧本导读','分角色练习','登台表演'] },
  { id:'m19', title:'难忘的第一次', subject:'chinese', grade:6, type:'写作指导', minutes:26, rating:4.9, desc:'审题立意，写出有细节、有真情实感的记叙文。', points:['审题立意','细节描写','升华主题'], chapters:['读懂题目','写出细节','点亮结尾'] },
  { id:'m20', title:'比例与百分数', subject:'math', grade:6, type:'练习册', minutes:30, rating:4.8, desc:'理解比例、百分数及其在生活中的实际应用。', points:['比例意义','百分数','实际应用'], chapters:['认识比例','百分数基础','生活中的应用'] },
  { id:'m21', title:'认识世界地理', subject:'science', grade:6, type:'科普视频', minutes:34, rating:4.7, desc:'了解世界七大洲四大洋与不同地区的气候文化。', points:['七大洲四大洋','气候类型','多元文化'], chapters:['我们的地球','七大洲','多样的世界'] },
  { id:'m22', title:'毕业季·成长纪念册', subject:'art', grade:6, type:'手工课', minutes:35, rating:4.9, desc:'动手制作成长纪念册，珍藏小学美好时光。', points:['版式设计','图文搭配','装订方法'], chapters:['收集素材','设计排版','装订完成'] },
  // —— 补全：覆盖 1-6 年级全部 8 个学科 ——
  { id:'m23', title:'奇妙的声音世界', subject:'science', grade:1, type:'科普视频', minutes:16, rating:4.8, desc:'认识生活中高低强弱的各种声音，探索声音的奥秘。', points:['声音的产生','声音的强弱','安静与噪声'], chapters:['听听看','声音从哪里来','保护听力'] },
  { id:'m24', title:'儿歌律动乐园', subject:'music', grade:1, type:'音乐课', minutes:15, rating:4.7, desc:'跟着儿歌拍手律动，感受音乐的节拍与快乐。', points:['节拍感知','动作律动','快乐歌唱'], chapters:['拍拍手','扭一扭','一起唱'] },
  { id:'m25', title:'快乐蹦跳操', subject:'pe', grade:1, type:'运动课', minutes:18, rating:4.8, desc:'在趣味蹦跳游戏中锻炼协调性，养成运动好习惯。', points:['双脚跳','平衡练习','运动安全'], chapters:['热身操','蹦跳游戏','放松整理'] },
  { id:'m26', title:'我会说谢谢', subject:'moral', grade:1, type:'故事', minutes:12, rating:4.7, desc:'通过小故事学会礼貌用语，做个懂感恩的好孩子。', points:['礼貌用语','表达感谢','友善待人'], chapters:['说声谢谢','对不起没关系','我是礼貌星'] },
  { id:'m27', title:'我的好朋友', subject:'chinese', grade:2, type:'写话指导', minutes:20, rating:4.7, desc:'学会观察并写下好朋友的特点，练习完整表达。', points:['观察外貌','抓住特点','写清事例'], chapters:['说说好朋友','写一两句话','读给大家听'] },
  { id:'m28', title:'Numbers 1 to 20', subject:'english', grade:2, type:'情景对话', minutes:14, rating:4.6, desc:'通过数数和游戏认识 1 到 20 的英文数字。', points:['数字词汇','数量表达','听读练习'], chapters:['认识数字','数一数','数字游戏'] },
  { id:'m29', title:'海底世界涂色', subject:'art', grade:2, type:'绘画课', minutes:22, rating:4.8, desc:'用丰富色彩描绘神奇的海底世界，发挥想象力。', points:['色彩搭配','涂色技巧','创意想象'], chapters:['认识海洋','画出海底','上色完成'] },
  { id:'m30', title:'小鼓手训练营', subject:'music', grade:2, type:'音乐课', minutes:18, rating:4.7, desc:'认识小鼓，练习稳定节拍，体验合奏的乐趣。', points:['节拍稳定','敲击方法','合奏配合'], chapters:['认识小鼓','敲出节奏','小小乐队'] },
  { id:'m31', title:'趣味障碍跑', subject:'pe', grade:2, type:'运动课', minutes:24, rating:4.8, desc:'穿越障碍完成接力，锻炼灵敏和勇气。', points:['灵敏协调','安全规则','团队协作'], chapters:['热身准备','障碍挑战','总结分享'] },
  { id:'m32', title:'天气与四季', subject:'science', grade:3, type:'科普视频', minutes:20, rating:4.8, desc:'认识常见天气现象与四季变化对生活的影响。', points:['天气符号','四季特征','生活应对'], chapters:['多变的天气','春夏秋冬','应对天气'] },
  { id:'m33', title:'纸盘动物面具', subject:'art', grade:3, type:'手工课', minutes:26, rating:4.7, desc:'用纸盘和彩笔制作可爱的动物面具。', points:['造型设计','色彩装饰','动手制作'], chapters:['设计动物','涂色装饰','戴上面具'] },
  { id:'m34', title:'乒乓球启蒙', subject:'pe', grade:3, type:'运动课', minutes:26, rating:4.7, desc:'学习握拍、颠球和对打，掌握乒乓球基础。', points:['握拍姿势','颠球练习','安全运动'], chapters:['认识球拍','颠球训练','对打体验'] },
  { id:'m35', title:'团结力量大', subject:'moral', grade:3, type:'故事', minutes:15, rating:4.6, desc:'通过故事理解合作与分享，学会与同伴友好相处。', points:['团队合作','乐于分享','互相帮助'], chapters:['一个好汉三个帮','分工合作','分享快乐'] },
  { id:'m36', title:'At the Zoo', subject:'english', grade:4, type:'情景对话', minutes:18, rating:4.7, desc:'在动物园场景中学习动物词汇与问答表达。', points:['动物词汇','What can you see','情景对话'], chapters:['认识动物','问答练习','逛动物园'] },
  { id:'m37', title:'水墨画初体验', subject:'art', grade:4, type:'绘画课', minutes:28, rating:4.8, desc:'感受中国水墨画的笔墨韵味，画出简单写意小品。', points:['执笔运笔','墨色变化','写意表现'], chapters:['认识水墨','运笔练习','完成小品'] },
  { id:'m38', title:'口风琴吹奏入门', subject:'music', grade:4, type:'音乐课', minutes:24, rating:4.6, desc:'学习口风琴的正确吹奏姿势与简单旋律。', points:['吹奏姿势','气息控制','简单旋律'], chapters:['认识口风琴','吹奏练习','吹出小曲'] },
  { id:'m39', title:'足球基础训练', subject:'pe', grade:4, type:'运动课', minutes:28, rating:4.7, desc:'学习脚内侧传接球与带球，体验团队配合。', points:['传接球','带球跑动','团队配合'], chapters:['热身运动','传接练习','趣味比赛'] },
  { id:'m40', title:'感恩有你', subject:'moral', grade:4, type:'故事', minutes:16, rating:4.7, desc:'发现身边人的付出，学会表达感恩与珍惜。', points:['发现付出','表达感恩','懂得珍惜'], chapters:['身边的爱','说声感谢','传递温暖'] },
  { id:'m41', title:'缩写故事有妙招', subject:'chinese', grade:5, type:'写作指导', minutes:24, rating:4.7, desc:'学习抓住主干缩写故事，做到简明又完整。', points:['抓主干','去枝叶','保留关键'], chapters:['认识缩写','提炼要点','写出短文'] },
  { id:'m42', title:'创意版画制作', subject:'art', grade:5, type:'手工课', minutes:30, rating:4.8, desc:'尝试简单的版画拓印，体验创作的乐趣。', points:['制版方法','拓印技巧','创意表达'], chapters:['设计图案','制作版面','拓印完成'] },
  { id:'m43', title:'经典儿歌合唱', subject:'music', grade:5, type:'音乐课', minutes:22, rating:4.7, desc:'分声部练习经典儿歌，感受合唱的和谐之美。', points:['分声部','音准节奏','合唱配合'], chapters:['学唱旋律','分声部练','合排展示'] },
  { id:'m44', title:'网络文明小达人', subject:'moral', grade:5, type:'故事', minutes:18, rating:4.6, desc:'学习文明上网、保护信息，做负责任的网络小公民。', points:['文明上网','信息保护','辨别信息'], chapters:['网络是什么','安全上网','文明发言'] },
  { id:'m45', title:'My Dream Job', subject:'english', grade:6, type:'情景对话', minutes:22, rating:4.7, desc:'学习描述理想职业，表达愿望与理由。', points:['职业词汇','I want to be','表达理由'], chapters:['认识职业','我的理想','说明理由'] },
  { id:'m46', title:'校园民谣弹唱', subject:'music', grade:6, type:'音乐课', minutes:24, rating:4.7, desc:'用简单和弦弹唱校园民谣，提升音乐表现力。', points:['和弦基础','弹唱配合','情感表达'], chapters:['认识和弦','弹唱练习','上台展示'] },
  { id:'m47', title:'篮球基础入门', subject:'pe', grade:6, type:'运动课', minutes:30, rating:4.8, desc:'学习运球、传球与投篮基础，享受篮球运动。', points:['运球手感','传球配合','投篮姿势'], chapters:['热身运动','运球传球','投篮体验'] },
  { id:'m48', title:'少年当自强', subject:'moral', grade:6, type:'故事', minutes:18, rating:4.7, desc:'通过榜样故事理解责任与担当，培养积极向上的品格。', points:['责任担当','坚持不懈','积极向上'], chapters:['榜样力量','面对困难','我的成长'] },
];

// 用户账户（演示：当前登录账号 xiaoman 已完成验证）
const USERS = [
  { id:'u01', name:'林小满', email:'xiaoman@sunny.edu.cn', phone:'138****6021', role:'student', grade:1, gender:'女', age:7, signature:'每天进步一点点！', status:'active', verified:true,  avatar:'林', color:'avatar--sky' },
  { id:'u02', name:'陈老师', email:'chen.teacher@sunny.edu.cn', phone:'139****3312', role:'teacher', dept:'语文教研组', gender:'女', age:32, signature:'让文字有温度，让课堂有笑声。', status:'active', verified:true, avatar:'陈', color:'avatar--berry' },
  { id:'u03', name:'周明远', email:'zhoumy@sunny.edu.cn', phone:'137****8890', role:'teacher', dept:'数学教研组', gender:'男', age:35, signature:'数学是思维的体操。', status:'active', verified:true, avatar:'周', color:'avatar--sun' },
  { id:'u04', name:'苏小雨', email:'suxiaoyu@sunny.edu.cn', phone:'136****2245', role:'student', grade:4, gender:'女', age:10, signature:'爱阅读，也爱发现新世界。', status:'active', verified:true, avatar:'苏', color:'avatar--mint' },
  { id:'u05', name:'王校长', email:'principal@sunny.edu.cn', phone:'135****0077', role:'admin', dept:'校务管理', gender:'男', age:45, signature:'为每个孩子的成长保驾护航。', status:'active', verified:true, avatar:'王', color:'avatar--brand' },
  { id:'u06', name:'李欣怡', email:'lixinyi@sunny.edu.cn', phone:'188****5634', role:'parent', dept:'学生家长', gender:'女', age:36, signature:'陪伴孩子一起成长。', status:'active', verified:true, avatar:'李', color:'avatar--lilac' },
  { id:'u07', name:'赵子轩', email:'zhaozx@sunny.edu.cn', phone:'186****9012', role:'student', grade:6, gender:'男', age:12, signature:'探索宇宙，从好奇心开始。', status:'active', verified:true, avatar:'赵', color:'avatar--teal' },
  { id:'u08', name:'孙老师', email:'sun.teacher@sunny.edu.cn', phone:'159****4478', role:'teacher', dept:'英语教研组', gender:'女', age:29, signature:'Language opens doors.', status:'active', verified:true, avatar:'孙', color:'avatar--sky' },
  { id:'u09', name:'吴桐', email:'wutong@sunny.edu.cn', phone:'133****6688', role:'student', grade:2, gender:'男', age:8, signature:'', status:'disabled', verified:false, avatar:'吴', color:'avatar--sun' },
  { id:'u10', name:'郑浩然', email:'zhenghr@sunny.edu.cn', phone:'177****3341', role:'student', grade:5, gender:'男', age:11, signature:'运动让我快乐。', status:'active', verified:true, avatar:'郑', color:'avatar--berry' },
  { id:'u11', name:'何老师', email:'he.teacher@sunny.edu.cn', phone:'152****7701', role:'teacher', dept:'科学教研组', gender:'男', age:41, signature:'保持好奇，保持热爱。', status:'active', verified:true, avatar:'何', color:'avatar--mint' },
  { id:'u12', name:'林妈妈', email:'linmama@sunny.edu.cn', phone:'189****2266', role:'parent', dept:'学生家长', gender:'女', age:38, signature:'', status:'pending', verified:false, avatar:'林', color:'avatar--lilac' },
];

// 部门 / 身份候选项（兼容历史自由文本；自定义人员表单使用下拉选择）
const DEPARTMENT_OPTIONS = ['语文教研组','数学教研组','英语教研组','科学教研组','校务管理','学生家长'];

// 权限项定义（数据化，可由超级管理员增改自定义项）
// builtin:true 为系统内置权限，支撑核心功能，不可删除；自定义项可增删改。
const BUILTIN_PERMISSIONS = [
  { key:'view_material', name:'查看学习资料', desc:'浏览与搜索资料库', builtin:true },
  { key:'download',      name:'下载资料',     desc:'下载课件与练习册', builtin:true },
  { key:'publish',       name:'发布资料',     desc:'上传并发布新资料', builtin:true },
  { key:'message',       name:'内部消息',     desc:'发送与查看站内消息', builtin:true },
  { key:'publish_notice',name:'发布消息通知', desc:'向全体成员发布广播通知', builtin:true },
  { key:'manage_user',   name:'用户管理',     desc:'创建与管理用户账户', builtin:true },
  { key:'manage_role',   name:'角色权限',     desc:'自定义角色与权限', builtin:true },
  { key:'view_stats',    name:'数据看板',     desc:'查看平台统计数据', builtin:true },
  { key:'manage_schedule',name:'课程表管理',  desc:'配置班级课程表与任课教师', builtin:true },
];
const PERMISSIONS = BUILTIN_PERMISSIONS.map(p => ({ ...p }));

// 视图门禁映射：主视图 → 所需权限项 key。
// null 表示无需权限（所有人可见）。超管可在后台修改该映射并持久化。
// 默认值与内置角色权限矩阵兼容，确保既有账号登录后入口照常可见。
const DEFAULT_VIEW_PERMISSIONS = {
  library: 'view_material',   // 学习资料
  shares:  'message',         // 学习感悟
  directory: 'message',       // 内部通讯录
  notices: 'publish_notice',  // 消息通知中心（发布入口按此权限门禁，所有成员可读）
  schedule: 'view_material',  // 课程表：有查看资料权限的成员均可查看，修改另有 manage_schedule 门禁
  // admin 视图固定仅超级管理员可见（不属于可分配权限项），不在此映射中
};
const ROLES = [
  { id:'r_admin',   name:'超级管理员', color:'berry', perms: PERMISSIONS.map(p=>p.key) },
  { id:'r_teacher', name:'教师',       color:'sky',   perms:['view_material','download','publish','message','view_stats'] },
  { id:'r_headteacher', name:'班级主任', color:'teal', perms:['view_material','download','publish','message','view_stats','manage_schedule'] },
  { id:'r_student', name:'学生',       color:'mint',  perms:['view_material','download','message'] },
  { id:'r_parent',  name:'家长',       color:'sun',   perms:['view_material','message'] },
];

// 通讯录成员（基于 USERS 扩展在线状态与部门）
const MEMBERS = USERS.map((u, i) => ({
  ...u,
  presence: ['online','online','away','online','offline','online','away','online','offline','online','online','away'][i],
  title: u.role==='teacher' ? `${u.dept}教师` : u.role==='admin' ? '校长 · 超级管理员' : u.role==='parent' ? '学生家长' : `${gradeLabel(u.grade)}学生`,
}));

// 会话与消息
const CONVERSATIONS = [
  { id:'c01', with:'u02', messages:[
    { from:'u02', text:'小满同学你好！这周的拼音练习做得很好，继续保持哦～', time:'09:12' },
    { from:'u01', text:'谢谢陈老师！我会继续努力的。', time:'09:15' },
    { from:'u02', text:'如果有不懂的地方，随时在平台上给我留言。', time:'09:16' },
  ], unread:0 },
  { id:'c02', with:'u03', messages:[
    { from:'u03', text:'乘法口诀的互动课上线啦，记得去练习一下。', time:'昨天 16:40' },
    { from:'u01', text:'好的周老师，我这就去看！', time:'昨天 16:52' },
  ], unread:1 },
  { id:'c03', with:'u06', messages:[
    { from:'u06', text:'小满，今晚记得早点休息呀。', time:'昨天 20:10' },
  ], unread:0 },
  { id:'c04', with:'u08', messages:[
    { from:'u08', text:'下周的英语小剧场，期待你的表演！', time:'周一 11:20' },
  ], unread:0 },
];

// 通知
const NOTIFICATIONS = [
  { id:'n01', icon:'i-star', title:'新资料上线', text:'《拼音王国大冒险》已添加到一年级语文', time:'10分钟前', read:false },
  { id:'n02', icon:'i-message', title:'陈老师给你发来消息', text:'这周的拼音练习做得很好，继续保持哦～', time:'1小时前', read:false },
  { id:'n03', icon:'i-shield-check', title:'账户安全提醒', text:'你的手机号和邮箱已完成验证', time:'昨天', read:false },
  { id:'n04', icon:'i-chart', title:'学习周报已生成', text:'本周你共学习了 5 节课程，很棒！', time:'2天前', read:true },
];

// 学习感悟分享（对应小程序 shares 表：id / owner_id / owner_name / title / content / grade / subject / likes / like_by / created_at）
const SHARES = [
  { id:'s01', owner_id:'u01', owner_name:'林小满', avatar:'林', color:'avatar--sky', grade:1, subject:'chinese', title:'我学会拼读啦！', content:'今天跟着拼音王国大冒险认识了声母韵母，回家给妈妈读了一段小故事，她夸我进步很大。原来学习可以这么有趣！', likes:12, like_by:['u02','u03','u06'], created_at:'2026-11-19 09:30', comments:[
    { id:'c01', kind:'teacher', owner_id:'u02', owner_name:'陈老师', avatar:'陈', color:'avatar--berry', content:'拼读进步很明显，注意平翘舌的区分哦！', created_at:'2026-11-19 10:05' },
    { id:'c02', kind:'student', owner_id:'u04', owner_name:'苏小雨', avatar:'苏', color:'avatar--mint', content:'我也喜欢这节课，拼音歌超好听～', created_at:'2026-11-19 11:20' },
  ] },
  { id:'s02', owner_id:'u02', owner_name:'陈老师', avatar:'陈', color:'avatar--berry', grade:3, subject:'chinese', title:'观察日记的小窍门', content:'带孩子们用五感观察校园里的桂花树：看颜色、闻香味、摸叶片、听风声。把感受写进日记，文字一下子就生动起来了。', likes:28, like_by:['u01','u04','u08','u11'], created_at:'2026-11-18 16:20', comments:[
    { id:'c03', kind:'group', owner_id:'u11', owner_name:'语文教研组', avatar:'语', color:'avatar--mint', content:'五感观察法已收录进年级教研案例，欢迎各位老师参考。', created_at:'2026-11-18 17:00' },
  ] },
  { id:'s03', owner_id:'u04', owner_name:'苏小雨', avatar:'苏', color:'avatar--mint', grade:4, subject:'math', title:'分数其实不难', content:'以前我总是搞不清几分之一和几分之几，今天用折纸的方法试了试，终于明白了！分享给同样觉得难的同学。', likes:9, like_by:['u01','u07'], created_at:'2026-11-18 14:05', comments:[
    { id:'c04', kind:'teacher', owner_id:'u03', owner_name:'周明远', avatar:'周', color:'avatar--sun', content:'折纸理解分数很棒，下次可以试试在数轴上表示。', created_at:'2026-11-18 15:10' },
  ] },
  { id:'s04', owner_id:'u07', owner_name:'赵子轩', avatar:'赵', color:'avatar--teal', grade:6, subject:'science', title:'太阳系真奇妙', content:'看完《地球与宇宙》后，我在家自己做了一个太阳系模型。原来地球自转带来昼夜，公转和地轴倾斜带来四季，太神奇了！', likes:17, like_by:['u01','u04','u10'], created_at:'2026-11-17 19:42', comments:[
    { id:'c05', kind:'student', owner_id:'u10', owner_name:'郑浩然', avatar:'郑', color:'avatar--berry', content:'模型好酷！你是用什么材料做的？', created_at:'2026-11-17 20:15' },
    { id:'c06', kind:'teacher', owner_id:'u11', owner_name:'何老师', avatar:'何', color:'avatar--mint', content:'动手实践是最好的学习，建议在班上做个展示。', created_at:'2026-11-18 08:30' },
  ] },
];

/* ==========================================================================
   本地演示数据持久化（localStorage）
   说明：Web 版默认使用本地演示数据，结构与云端 shares/messages/profiles 对应。
   ========================================================================== */
const STORAGE_KEY = (window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1';

const SunnyStore = {
  load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  save(patch) {
    try {
      const prev = this.load() || {};
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({}, prev, patch)));
    } catch (e) {
      // 隐私模式或存储不可用时静默降级为内存态
    }
  },
  clear() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  },
};

window.SunnyStore = SunnyStore;
