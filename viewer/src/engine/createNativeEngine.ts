import {WebEngine} from './WebEngine';
export const createEngine=(canvas:HTMLCanvasElement)=>{
 const engine=new WebEngine(canvas);
 if((window as Window&{mutracerWorkflow?:boolean}).mutracerWorkflow)void import('../dev/nativeWorkflow').then(module=>module.run(engine));
 return engine;
};
