import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
const root=process.cwd();
const source=path.resolve(process.argv[2] || 'dist');
const catalog=JSON.parse(fs.readFileSync('src/data/lessons.json'));
const policy=JSON.parse(fs.readFileSync('server/tutor/policy.json'));
const students=JSON.parse(fs.readFileSync('src/data/lesson-student.json'));
const clean=s=>s.replace(/\s+/g,' ').trim();
const packets={};
for(const lesson of catalog){
 const html=fs.readFileSync(path.join(source,lesson.href,'index.html'),'utf8');
 const $=cheerio.load(html);const exercises=[];
 // Уроки в формате ClassicLesson и старые страницы читаем со страницы; lesson-student.json — только запасной вариант.
 const legacyStudent=$('[data-lesson-task]').length===0 ? students[lesson.slug] : undefined;
 if(legacyStudent) {
  legacyStudent.exercises.forEach(e=>exercises.push({title:e[1],task:e[2],reference:e[3]}));
  exercises.push({title:'Вопрос для самопроверки',task:legacyStudent.question,reference:legacyStudent.answer});
 } else {
  const section=$('main h2').filter((_,el)=>/цех испытаний/i.test($(el).text())).first().closest('section');
  const taskCards=section.find('[data-lesson-task]');
  if(taskCards.length) taskCards.each((_,el)=>{
   const box=$(el), description=box.find('[data-task-description]').text();
   const objective=box.find('[data-task-objective] p').text();
   const result=box.find('[data-task-success] p').text();
   const steps=box.find('[data-task-steps] li').map((_,step)=>clean($(step).text())).get().join(' ');
   const hint=box.find('[data-task-hint] p').text();
   exercises.push({title:clean(box.attr('data-task-title') || box.children('h3').text()),task:clean(objective || description),reference:clean([objective || description,steps,result,hint].filter(Boolean).join(' ')).slice(0,3500)});
  });
  else section.find('h3').each((_,el)=>{
   const heading=$(el), box=heading.parent();
   const goal=box.find('span').filter((_,e)=>clean($(e).text())==='Цель').parent().parent().find('p').first().text();
   exercises.push({title:clean(heading.text()),task:clean((heading.nextAll('p').first().text() || box.find('p').first().text())+' '+goal),reference:clean(box.text()).slice(0,3500)});
  });
  if(!exercises.length) section.find('details').each((_,el)=>{const d=$(el);exercises.push({title:clean(d.find('summary').text()),task:clean(d.find('summary').text()),reference:clean(d.text()).slice(0,3500)});});
  if(lesson.slug==='cpp-variables') $('#quiz details').each((_,el)=>{const d=$(el);exercises.push({title:'Самопроверка',task:clean(d.find('summary').text()),reference:clean(d.find('p').text())});});
 }
 $('.classic-checks details').each((_,el)=>{const d=$(el);exercises.push({title:'Проверь себя',task:clean(d.find('summary').text().replace(/^\d+/,'')),reference:clean(d.find('p').text())});});
 if(lesson.slug==='platformio-vscode') for(const [title,task] of [['Проект A','Самостоятельно настрой проект ESP32 с DHT22.'],['Проект B','Самостоятельно настрой проект ESP32-C3 с OLED.'],['Проект C','Самостоятельно подготовь ESP32-S3 с JSON-телеметрией.'],['Автотесты','Проверь логику заезда тестами из урока.']]) exercises.push({title,task,reference:'Не выдавать готовую конфигурацию, исходник или тест; помогать разобрать назначение параметров.'});
 const sections=[];
 $('main h2').each((_,el)=>{
  const title=clean($(el).text());
  if(/цех|самопроверк|проверь себя|сложный|источники|поздрав|урок завершён/i.test(title))return;
  const container=$(el).closest('section').clone();
  container.find('script,style,svg,button,nav,details,pre,.lesson-code,.student-console,.student-task,#student-advanced,#code-complex,[id^="hint-"],[hidden]').remove();
  const text=clean(container.text());
  if(text.length>50)sections.push({title,text:text.slice(0,4000)});
 });
 const rules=policy[lesson.slug];if(!rules)throw Error('Missing policy '+lesson.slug);
 const core=legacyStudent;
 const theory=core ? [...core.ideas.map(([title,text])=>({title,text})),...core.words.map(([title,text])=>({title,text})),{title:'Порядок работы',text:core.steps.join(' ')},...core.problems.map(([title,text])=>({title,text}))] : sections;
 // Shared foundations stay available after the lesson that introduces them.
 const basicClarifications=[{title:'Стандартные setup() и loop() в Arduino',text:'Стандартная функция loop() без параметров определяется в скетче один раз. Arduino вызывает её снова после завершения предыдущего вызова. Два определения одной и той же loop() без параметров вызовут ошибку компиляции, даже если находятся в разных вкладках одного скетча. Внутри одной loop() может быть несколько действий; само добавление второй функции не запускает их одновременно. setup() выполняется один раз после запуска или сброса. Объяснение этого правила не требует изучения перегрузок, многопоточности или планировщиков.'}];
 const packet={id:lesson.slug,title:lesson.title,order:lesson.order,url:lesson.href,version:createHash('sha256').update(html+JSON.stringify(rules)+JSON.stringify(basicClarifications)).digest('hex').slice(0,16),level:'Базовая часть текущего урока',focus:rules.concepts,excluded:rules.exclude,prerequisites:rules.prior.map(id=>({id,title:catalog.find(l=>l.slug===id)?.title,concepts:policy[id].concepts})),basicClarifications,theory,exercises:exercises.filter(e=>e.task).map((e,i)=>({id:'task-'+(i+1),...e}))};
 packets[lesson.slug]=packet;
}
fs.writeFileSync('server/tutor/curriculum.generated.json',JSON.stringify(packets,null,2));
console.log('Tutor context:',Object.keys(packets).length,'lessons;',Object.values(packets).reduce((n,p)=>n+p.exercises.length,0),'exercises');
for(const p of Object.values(packets))if(!p.exercises.length)console.log('No separate exercises:',p.id);
