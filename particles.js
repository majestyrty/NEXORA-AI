const canvas = document.createElement("canvas");

canvas.id = "particleCanvas";

const parentEl = document.body; // place the particle canvas behind everything
ndocument.body.appendChild(canvas);
nconst ctx = canvas.getContext("2d");
nfunction resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

resizeCanvas();



let particles = [];

const particleCount = 80;



class Particle {

    constructor(){

        this.x = Math.random() * canvas.width;

        this.y = Math.random() * canvas.height;

        this.size = Math.random() * 3 + 1;

        this.speedX = Math.random() * 1.5 - 0.75;

        this.speedY = Math.random() * 1.5 - 0.75;

    }



    update(){

        this.x += this.speedX;

        this.y += this.speedY;



        if(this.x < 0 || this.x > canvas.width){

            this.speedX *= -1;

        }


        if(this.y < 0 || this.y > canvas.height){

            this.speedY *= -1;

        }

    }



    draw(){

        ctx.beginPath();

        ctx.arc(
            this.x,
            this.y,
            this.size,
            0,
            Math.PI * 2
        );


        ctx.fillStyle =
        "rgba(0,180,255,0.8)";


        ctx.fill();

    }

}




function createParticles(){

    for(let i=0;i<particleCount;i++){

        particles.push(new Particle());

    }

}


createParticles();



function connectParticles(){

    for(let a=0;a<particles.length;a++){

        for(let b=a;b<particles.length;b++){


            let distance =
            Math.sqrt(

            Math.pow(
            particles[a].x-particles[b].x,2)

            +

            Math.pow(
            particles[a].y-particles[b].y,2)

            );


            if(distance < 120){

                ctx.beginPath();


                ctx.strokeStyle =
                "rgba(0,180,255,0.15)";


                ctx.lineWidth = 1;


                ctx.moveTo(
                particles[a].x,
                particles[a].y
                );


                ctx.lineTo(
                particles[b].x,
                particles[b].y
                );


                ctx.stroke();

            }

        }

    }

}





function animate(){

    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );


    particles.forEach(p=>{

        p.update();

        p.draw();

    });


    connectParticles();


    requestAnimationFrame(animate);

}


animate();





window.addEventListener("resize",()=>{
    resizeCanvas();
});